import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const rootFacades = new Set([
  'configuration.ts',
  'index.ts',
  'measure-interaction.ts',
  'memory.ts',
  'observe-page.ts',
  'run-journey.ts',
  'search-journey.ts',
  'smoothness.ts',
  'trace.ts',
]);
const executableEntries = new Set(['cli.ts', 'worker-cli.ts']);
// This existing type-level cycle is transitional debt, not a model for new
// dependencies. The gate fails if another feature cycle appears or if this
// exception becomes stale after the boundary is repaired.
const allowedFeatureCycles = new Set(['journey,observation']);

function sourceFiles(sourceRoot) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  }
  visit(sourceRoot);
  return files.sort();
}

function display(root, path) {
  return relative(root, path).split(sep).join('/');
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const requested = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [requested.slice(0, -3) + '.ts']
    : [requested, requested + '.ts', join(requested, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate));
}

function featureOwner(sourceRoot, path) {
  const parts = relative(sourceRoot, path).split(sep);
  return parts.length > 1 ? parts[0] : undefined;
}

function importSpecifiers(path, text) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const stacked = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    stacked.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), lowLinks.get(dependency)),
        );
      } else if (stacked.has(dependency)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), indices.get(dependency)),
        );
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      stacked.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
  }

  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return components;
}

export function checkArchitecture(root) {
  const repositoryRoot = resolve(root);
  const sourceRoot = join(repositoryRoot, 'src');
  const files = sourceFiles(sourceRoot);
  const sourceSet = new Set(files);
  const graph = new Map(files.map((path) => [path, []]));
  const featureGraph = new Map();
  const features = new Set(
    files.map((path) => featureOwner(sourceRoot, path)).filter(Boolean),
  );
  const violations = [];
  for (const importer of files) {
    const text = readFileSync(importer, 'utf8');
    for (const specifier of importSpecifiers(importer, text)) {
      if (!specifier.startsWith('.')) continue;
      const target = resolveImport(importer, specifier);
      if (!target) {
        violations.push({
          path: display(repositoryRoot, importer),
          rule: 'architecture.unresolved-import',
          message: `relative import does not resolve to TypeScript source: ${specifier}`,
        });
        continue;
      }
      const sourceRelative = relative(sourceRoot, target);
      if (
        sourceRelative === '..' ||
        sourceRelative.startsWith(`..${sep}`) ||
        !sourceSet.has(target)
      ) {
        violations.push({
          path: display(repositoryRoot, importer),
          rule: 'architecture.source-boundary',
          message: `production source imports outside src: ${specifier}`,
        });
        continue;
      }
      graph.get(importer).push(target);
      const importerFeature = featureOwner(sourceRoot, importer);
      const targetFeature = featureOwner(sourceRoot, target);
      if (
        importerFeature &&
        targetFeature &&
        importerFeature !== targetFeature
      ) {
        if (!featureGraph.has(importerFeature))
          featureGraph.set(importerFeature, new Set());
        if (!featureGraph.has(targetFeature))
          featureGraph.set(targetFeature, new Set());
        featureGraph.get(importerFeature).add(targetFeature);
      }
      const importerRelative = relative(sourceRoot, importer);
      const targetRelative = relative(sourceRoot, target);
      if (
        importerRelative.includes(sep) &&
        (rootFacades.has(targetRelative) ||
          executableEntries.has(targetRelative))
      ) {
        violations.push({
          path: display(repositoryRoot, importer),
          rule: 'architecture.inward-dependency',
          message: `feature implementation imports outer entry/facade ${targetRelative.split(sep).join('/')}`,
        });
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node]
        .map((path) => display(repositoryRoot, path))
        .join(' -> ');
      violations.push({
        path: display(repositoryRoot, node),
        rule: 'architecture.cycle',
        message: `production import cycle: ${cycle}`,
      });
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node)) visit(dependency);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const file of files) visit(file);

  const seenAllowedFeatureCycles = new Set();
  for (const component of stronglyConnectedComponents(featureGraph)) {
    if (component.length < 2) continue;
    const key = [...component].sort().join(',');
    if (allowedFeatureCycles.has(key)) {
      seenAllowedFeatureCycles.add(key);
      continue;
    }
    violations.push({
      path: 'src',
      rule: 'architecture.feature-cycle',
      message: `feature dependency cycle: ${[...component].sort().join(' <-> ')}`,
    });
  }
  for (const key of allowedFeatureCycles) {
    const membersExist = key
      .split(',')
      .every((feature) => features.has(feature));
    if (membersExist && !seenAllowedFeatureCycles.has(key)) {
      violations.push({
        path: 'tools/architecture-check.mjs',
        rule: 'architecture.stale-cycle-exception',
        message: `remove resolved feature-cycle exception: ${key}`,
      });
    }
  }
  const unique = new Map(
    violations.map((item) => [
      `${item.path}:${item.rule}:${item.message}`,
      item,
    ]),
  );
  return [...unique.values()].sort((left, right) =>
    `${left.path}:${left.rule}`.localeCompare(`${right.path}:${right.rule}`),
  );
}

export function main(root = process.cwd()) {
  const violations = checkArchitecture(root);
  for (const item of violations)
    console.error(`${item.path}: [${item.rule}] ${item.message}`);
  if (violations.length > 0) {
    console.error(
      `architecture-check: found ${violations.length} violation(s); see docs/development/architecture.md`,
    );
    return 1;
  }
  console.log('architecture-check: production import boundaries passed');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv[2]);
