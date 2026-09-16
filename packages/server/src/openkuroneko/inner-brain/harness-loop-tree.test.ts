import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPathInLoopRoots,
  createHarnessLoopTreeStore,
  resolveActiveLoopEntry,
} from './harness-loop-tree.js';

describe('harnessLoopTree', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lt-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('seeds files into an immutable tree with manifest', () => {
    fs.writeFileSync(path.join(root, 'loop.ts'), 'export const n = 1;\n');
    const store = createHarnessLoopTreeStore(root);
    const m = store.seed({
      files: [{ from: 'loop.ts', to: 'loop.ts' }],
    });
    expect(m.treeId).toMatch(/^lt-/);
    expect(m.files['loop.ts']).toBeTruthy();
    expect(store.readFile(m.treeId, 'loop.ts')).toContain('n = 1');
    expect(() =>
      store.seed({
        treeId: m.treeId,
        files: [{ from: 'loop.ts', to: 'other.ts' }],
      }),
    ).toThrow(/immutable/);
  });

  it('applyPatches COW writes a new tree and rejects path escape (H11)', () => {
    fs.writeFileSync(path.join(root, 'loop.ts'), 'v1\n');
    const store = createHarnessLoopTreeStore(root);
    const parent = store.seed({ files: [{ from: 'loop.ts', to: 'loop.ts' }] });
    expect(() =>
      store.applyPatches(parent.treeId, [{ path: '../escape.ts', action: 'write', content: 'x' }], [
        '',
      ]),
    ).toThrow(/H11/);
    expect(() =>
      store.applyPatches(
        parent.treeId,
        [{ path: 'secret.ts', action: 'write', content: 'x' }],
        ['loop'],
      ),
    ).toThrow(/H11/);

    const next = store.applyPatches(
      parent.treeId,
      [{ path: 'loop.ts', action: 'write', content: 'v2\n' }],
      [''],
    );
    expect(next.treeId).not.toBe(parent.treeId);
    expect(next.parentTreeId).toBe(parent.treeId);
    expect(store.readFile(parent.treeId, 'loop.ts')).toBe('v1\n');
    expect(store.readFile(next.treeId, 'loop.ts')).toBe('v2\n');
  });

  it('rejects empty / noop patches (H12)', () => {
    fs.writeFileSync(path.join(root, 'loop.ts'), 'same\n');
    const store = createHarnessLoopTreeStore(root);
    const parent = store.seed({ files: [{ from: 'loop.ts', to: 'loop.ts' }] });
    expect(() => store.applyPatches(parent.treeId, [], [''])).toThrow(/H12/);
    expect(() =>
      store.applyPatches(
        parent.treeId,
        [{ path: 'loop.ts', action: 'write', content: 'same\n' }],
        [''],
      ),
    ).toThrow(/H12/);
  });

  it('resolveEntry / resolveActiveLoopEntry (H10)', () => {
    fs.writeFileSync(path.join(root, 'entry.ts'), 'ok\n');
    const store = createHarnessLoopTreeStore(root);
    const m = store.seed({ files: [{ from: 'entry.ts', to: 'entry.ts' }] });
    const abs = store.resolveEntry(m.treeId, 'entry.ts');
    expect(abs.endsWith(`${path.sep}entry.ts`)).toBe(true);
    expect(resolveActiveLoopEntry(root, { loopTreeId: m.treeId, loopEntry: 'entry.ts' })).toBe(
      abs,
    );
    expect(resolveActiveLoopEntry(root, {})).toBeNull();
  });

  it('assertPathInLoopRoots normalizes', () => {
    expect(assertPathInLoopRoots('a/b.ts', ['a'])).toBe('a/b.ts');
    expect(() => assertPathInLoopRoots('..\\x', ['a'])).toThrow(/H11/);
  });
});
