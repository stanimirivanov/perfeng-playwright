import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';

import {
  nativeSelection,
  signedSelection,
  verifyProjection,
} from '../tools/contracts-distribution.js';

const fixture = 'native-worker/v2/examples/acquire.json';
const upstreamFixture = `api/${fixture}`;
const openapi = 'api/native-worker/v2/openapi.json';
const sha = (content: Buffer) =>
  createHash('sha256').update(content).digest('hex');
const fixtureBytes = Buffer.from('{}\n');
const apiBytes = Buffer.from('{"openapi":"3.1.0"}\n');
const lock = {
  v2SourceRevision: 'a'.repeat(40),
  reviewedV2OpenApiSha256: sha(apiBytes),
  files: { [fixture]: sha(fixtureBytes) },
};

test('selects only the exact canonical Native Worker fixture paths and API digest', () => {
  expect(nativeSelection(lock)).toEqual({
    sourceRevision: lock.v2SourceRevision,
    members: {
      [upstreamFixture]: {
        destination: upstreamFixture,
        sha256: sha(fixtureBytes),
      },
      [openapi]: { destination: openapi, sha256: sha(apiBytes) },
    },
  });
  expect(() =>
    nativeSelection({
      ...lock,
      files: { '../fixture.json': sha(fixtureBytes) },
    }),
  ).toThrow('Invalid Native Worker fixture path');
  expect(() => nativeSelection({ ...lock, files: {} })).toThrow(
    'No Native Worker fixtures',
  );
});

test('rejects missing or changed projection bytes and mismatched vendored fixtures', () => {
  const projection = new Map([
    [upstreamFixture, fixtureBytes],
    [openapi, apiBytes],
  ]);
  const local = new Map([[fixture, fixtureBytes]]);
  const check = () =>
    verifyProjection(
      lock,
      (path) => projection.get(path),
      (path) => local.get(path),
      [...local.keys()],
    );
  expect(check()).toBe(1);
  local.set('native-worker/v2/examples/unreviewed.json', fixtureBytes);
  expect(check).toThrow('Vendored fixture inventory differs');
  local.delete('native-worker/v2/examples/unreviewed.json');
  projection.delete(upstreamFixture);
  expect(check).toThrow('Projected digest differs');
  projection.set(upstreamFixture, Buffer.from('{}'));
  expect(check).toThrow('Projected digest differs');
  projection.set(upstreamFixture, fixtureBytes);
  local.set(fixture, apiBytes);
  expect(check).toThrow('Vendored fixture differs');
});

test('requires the pinned manifest and retains all signed members at their original paths', () => {
  const manifest = Buffer.from(
    JSON.stringify({
      releaseId: 'history-1',
      source: { revision: lock.v2SourceRevision, version: '0.27.0' },
      members: {
        [upstreamFixture]: sha(fixtureBytes),
        [openapi]: sha(apiBytes),
        LICENSE: sha(Buffer.from('license')),
      },
    }),
  );
  const pins = {
    historyRelease: 'history-1',
    version: '0.27.0',
    manifestSha256: sha(manifest),
  };
  expect(signedSelection(lock, pins, manifest).members.LICENSE).toEqual({
    destination: 'LICENSE',
    sha256: sha(Buffer.from('license')),
  });
  expect(() =>
    signedSelection(lock, { ...pins, historyRelease: 'other' }, manifest),
  ).toThrow('Pinned historical profile differs');
  expect(() =>
    signedSelection(lock, pins, Buffer.concat([manifest, Buffer.from('\n')])),
  ).toThrow('Pinned historical manifest digest differs');
});
