import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataRoot, resolveStoredWorkDir, safeAgentSid } from './data-root.js';

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

describe('resolveStoredWorkDir', () => {
  const localRoot = path.resolve('D:/kuroneko/packages/server/data-yuanbao');

  it('remaps /data/workspaces/... to current DATA_ROOT', () => {
    expect(resolveStoredWorkDir('/data/workspaces/task-ib-abc', localRoot)).toBe(
      path.join(localRoot, 'workspaces', 'task-ib-abc'),
    );
  });

  it('leaves native absolute paths unchanged', () => {
    const native = path.join(localRoot, 'workspaces', 'task-ib-abc');
    expect(resolveStoredWorkDir(native, localRoot)).toBe(native);
  });
});

describe('safeAgentSid', () => {
  it('replaces Windows-illegal colons so SID is usable as a filename', () => {
    // `:` is reserved on Windows (NTFS ADS separator) → would throw ENOENT.
    expect(safeAgentSid('idp:agent:kuroneko')).toBe('idp_agent_kuroneko');
  });

  it('strips other reserved path chars', () => {
    expect(safeAgentSid('a/b\\c<d>e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('keeps already-safe sids intact', () => {
    expect(safeAgentSid('idp_agent_kuroneko')).toBe('idp_agent_kuroneko');
  });

  it('falls back to "default" for empty input', () => {
    expect(safeAgentSid('')).toBe('default');
  });

  it('caps length at 128 chars', () => {
    expect(safeAgentSid('a'.repeat(300)).length).toBe(128);
  });
});
