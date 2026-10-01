import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const issueHeadings = [
  'Goal',
  'Scope',
  'Design decisions',
  'Security and operations',
  'Acceptance criteria',
  'Verification',
  'Out of scope',
];
const pullRequestHeadings = [
  'Linked work',
  'Outcome and scope',
  'Design, compatibility and operations',
  'Verification',
  'Limitations and review',
];
const ignoredDirectories = new Set([
  '.git',
  '.idea',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const linkPattern = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
const referencePattern = /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
const actionLinePattern = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/;
const blockScalarPattern =
  /^\s*(?:-\s*)?[^#:'"]+:\s*[|>][+-]?(?:\d+)?\s*(?:#.*)?$/;

function repositoryFiles(root, predicate) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (predicate(path)) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

function withoutFences(text) {
  let fenced = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function slug(heading) {
  return heading
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

function anchors(text) {
  const values = new Set();
  const counts = new Map();
  for (const line of withoutFences(text).split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    values.add(count === 0 ? base : `${base}-${count}`);
  }
  return values;
}

function destination(raw) {
  const value = raw.trim();
  if (value.startsWith('<') && value.includes('>'))
    return value.slice(1, value.indexOf('>'));
  return value.split(/\s+/, 1)[0];
}

function add(violations, root, path, line, rule, message, fix) {
  violations.push({
    path: relative(root, path).split(sep).join('/'),
    line,
    rule,
    message,
    fix,
  });
}

function checkMarkdown(root, path, violations) {
  const text = readFileSync(path, 'utf8');
  const visible = withoutFences(text);
  const relativePath = relative(root, path).split(sep).join('/');
  const words = visible.match(/\b\w+\b/g)?.length ?? 0;
  const sections = visible.match(/^##\s+/gm)?.length ?? 0;
  const selective =
    relativePath.startsWith('docs/') &&
    /(architecture|security|migration|operational|harness)/i.test(relativePath);
  if (
    (words >= 800 || sections > 5 || selective) &&
    !/^## TL;DR\s*$/m.test(visible)
  ) {
    add(
      violations,
      root,
      path,
      1,
      'docs.tldr',
      'long or selectively read documentation has no TL;DR',
      'add a useful `## TL;DR` after the title and metadata',
    );
  }

  const candidates = [];
  for (const match of visible.matchAll(linkPattern))
    candidates.push([lineAt(visible, match.index), destination(match[1])]);
  for (const match of visible.matchAll(referencePattern))
    candidates.push([
      lineAt(visible, match.index),
      destination(match[1] ?? match[2]),
    ]);
  for (const [line, value] of candidates) {
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    const hash = value.indexOf('#');
    const location = hash === -1 ? value : value.slice(0, hash);
    const fragment = hash === -1 ? '' : value.slice(hash + 1);
    const target = location
      ? resolve(dirname(path), decodeURIComponent(location))
      : path;
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      add(
        violations,
        root,
        path,
        line,
        'docs.link',
        `local link escapes the repository: ${value}`,
        'link to a repository-owned path',
      );
    } else if (!existsSync(target)) {
      add(
        violations,
        root,
        path,
        line,
        'docs.link',
        `local link target does not exist: ${value}`,
        'correct the path or remove the stale link',
      );
    } else if (
      fragment &&
      statSync(target).isFile() &&
      !anchors(readFileSync(target, 'utf8')).has(fragment)
    ) {
      add(
        violations,
        root,
        path,
        line,
        'docs.anchor',
        `heading anchor does not exist: ${value}`,
        'link to an existing heading',
      );
    }
  }
}

function checkTemplates(root, violations) {
  const templates = [
    [
      join(root, '.github/ISSUE_TEMPLATE/work-item.md'),
      issueHeadings,
      'template.issue',
    ],
    [
      join(root, '.github/PULL_REQUEST_TEMPLATE.md'),
      pullRequestHeadings,
      'template.pull-request',
    ],
  ];
  for (const [path, expected, rule] of templates) {
    if (!existsSync(path)) {
      add(
        violations,
        root,
        path,
        1,
        rule,
        'required template is missing',
        'restore the canonical template',
      );
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const actual = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map(
      (match) => match[1],
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      add(
        violations,
        root,
        path,
        1,
        rule,
        `section order is ${JSON.stringify(actual)}`,
        `use ${JSON.stringify(expected)}`,
      );
    }
    if (!text.includes('**Milestone:**') && !text.includes('- Milestone:')) {
      add(
        violations,
        root,
        path,
        1,
        rule,
        'milestone field is missing',
        'restore the exact milestone prompt',
      );
    }
  }
}

function checkAdrs(root, violations) {
  const directory = join(root, 'docs/decisions');
  if (!existsSync(directory)) return;
  const indexPath = join(directory, 'README.md');
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  const numbers = [];
  for (const path of repositoryFiles(directory, (candidate) =>
    /^\d{4}-[a-z0-9-]+\.md$/.test(candidate.split(sep).at(-1)),
  )) {
    const name = path.split(sep).at(-1);
    const number = Number(name.slice(0, 4));
    numbers.push(number);
    const text = readFileSync(path, 'utf8');
    const heading = /^# ADR-(\d{4}):\s+\S/.exec(text);
    if (!heading || Number(heading[1]) !== number) {
      add(
        violations,
        root,
        path,
        1,
        'adr.heading',
        'ADR heading and filename number disagree',
        'use `# ADR-NNNN: Decision title`',
      );
    }
    const metadata = new Map(
      [...text.matchAll(/^- ([A-Za-z][A-Za-z ]+):\s*(.*)$/gm)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    for (const field of ['Status', 'Date']) {
      if (!metadata.get(field))
        add(
          violations,
          root,
          path,
          1,
          'adr.metadata',
          `${field} metadata is missing`,
          `add \`- ${field}: ...\``,
        );
    }
    const milestone = metadata.get('Milestone');
    if (milestone && !/^M\d{2} — .+/.test(milestone)) {
      add(
        violations,
        root,
        path,
        1,
        'adr.milestone',
        'milestone does not use the published Perfeng form',
        'use `MNN — Outcome`',
      );
    }
    if (!index.includes(`(${name})`)) {
      add(
        violations,
        root,
        indexPath,
        1,
        'adr.index',
        `${name} is not indexed`,
        'add a link to the ADR index',
      );
    }
  }
  numbers.sort((left, right) => left - right);
  const expected = Array.from(
    { length: numbers.at(-1) ?? 0 },
    (_, index) => index + 1,
  );
  if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
    add(
      violations,
      root,
      indexPath,
      1,
      'adr.sequence',
      `ADR sequence is ${JSON.stringify(numbers)}`,
      'allocate sequential numbers without reusing gaps',
    );
  }
}

function checkActions(root, violations) {
  const paths = [];
  const workflows = join(root, '.github/workflows');
  if (existsSync(workflows))
    paths.push(
      ...repositoryFiles(workflows, (candidate) =>
        ['.yml', '.yaml'].includes(extname(candidate)),
      ),
    );
  const actions = join(root, '.github/actions');
  if (existsSync(actions))
    paths.push(
      ...repositoryFiles(actions, (candidate) =>
        ['action.yml', 'action.yaml'].includes(candidate.split(sep).at(-1)),
      ),
    );

  for (const path of [...new Set(paths)].sort()) {
    const text = readFileSync(path, 'utf8');
    let blockIndent;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const indent = line.match(/^\s*/)[0].length;
      if (blockIndent !== undefined) {
        if (!line.trim() || indent > blockIndent) continue;
        blockIndent = undefined;
      }
      if (blockScalarPattern.test(line)) {
        blockIndent = indent;
        continue;
      }

      const match = actionLinePattern.exec(line);
      if (!match) continue;
      let reference = match[1].trim();
      if (reference.startsWith("'") || reference.startsWith('"')) {
        const quote = reference[0];
        const end = reference.indexOf(quote, 1);
        if (end === -1) continue;
        reference = reference.slice(1, end);
      } else {
        reference = reference.replace(/\s+#.*$/, '').trim();
      }
      if (reference.startsWith('./') || reference.startsWith('docker://'))
        continue;
      const separator = reference.lastIndexOf('@');
      if (separator <= 0) {
        add(
          violations,
          root,
          path,
          index + 1,
          'workflow.action-version',
          `${reference} has no action revision`,
          `use ${reference}@vN`,
        );
        continue;
      }
      const action = reference.slice(0, separator);
      const revision = reference.slice(separator + 1);
      if (/^v\d+$/.test(revision)) continue;
      add(
        violations,
        root,
        path,
        index + 1,
        'workflow.action-version',
        `${action} uses non-major action revision ${revision}`,
        `use ${action}@vN; keep immutable hashes in deployment/ref fields`,
      );
    }
  }
}

export function checkRepository(root) {
  const absoluteRoot = resolve(root);
  const violations = [];
  for (const path of repositoryFiles(
    absoluteRoot,
    (candidate) => extname(candidate) === '.md',
  )) {
    const rel = relative(absoluteRoot, path).split(sep).join('/');
    if (
      rel.startsWith('.github/ISSUE_TEMPLATE/') ||
      rel === '.github/PULL_REQUEST_TEMPLATE.md'
    )
      continue;
    checkMarkdown(absoluteRoot, path, violations);
  }
  checkTemplates(absoluteRoot, violations);
  checkAdrs(absoluteRoot, violations);
  checkActions(absoluteRoot, violations);
  return violations.sort((left, right) =>
    `${left.path}:${left.line}:${left.rule}`.localeCompare(
      `${right.path}:${right.line}:${right.rule}`,
    ),
  );
}

export function main(root = process.cwd()) {
  const violations = checkRepository(root);
  for (const item of violations)
    console.error(
      `${item.path}:${item.line}: [${item.rule}] ${item.message}; fix: ${item.fix}`,
    );
  if (violations.length > 0) {
    console.error(`repo-check: found ${violations.length} violation(s)`);
    return 1;
  }
  console.log('repo-check: repository policy checks passed');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv[2]);
