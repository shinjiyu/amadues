import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataRoot } from './data-root.js';

describe('resolveDataRoot', () => {
  const repo = '/repo';
  const serverDir = '/repo/packages/server/src';

  it('defaults to packages/server/data', () => {
    expect(resolveDataRoot(repo, serverDir)).toBe(path.join(serverDir, '..', 'data'));
  });

  it('resolves relative UTLRA_DATA_ROOT against repo root', () => {
    expect(resolveDataRoot(repo, serverDir, 'packages/server/data-aoi')).toBe(
      path.resolve(repo, 'packages/server/data-aoi'),
    );
  });

  it('keeps absolute UTLRA_DATA_ROOT (Docker volume /data)', () => {
    expect(resolveDataRoot(repo, serverDir, '/data')).toBe('/data');
  });
});
