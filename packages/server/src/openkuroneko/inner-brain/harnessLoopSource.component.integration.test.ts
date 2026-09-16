/**
 * Component: upgrade with loopTree patches → next load uses new tree (H10).
 * ADL: doc/structurizr/HARNESS-RSI.md §12 / H10–H12
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { createHarnessLoopTreeStore, resolveActiveLoopEntry } from './harness-loop-tree.js';
import { reviseHarness } from './harness-revise.js';
import { gateHarness } from './harness-gate.js';
import { writeRunContext } from './run-context-store.js';
import { createNodeSkillStore } from './node-skill-store.js';

describe('harnessLoopSource component', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ls-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('revise→gate→upgrade switches loopEntry content under active H (H10)', () => {
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export const mark = "v1";\n');
    const trees = createHarnessLoopTreeStore(root);
    const t0 = trees.seed({ files: [{ from: 'entry.ts', to: 'entry.ts' }] });
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-v1',
      refs: {
        loopTreeId: t0.treeId,
        loopRoots: [''],
        loopEntry: 'entry.ts',
        localNodeIds: ['local/loop'],
        gateChecks: [{ id: 'noop', command: 'node -e "process.exit(0)"' }],
      },
      status: 'gated_ok',
    });
    const ptr = createHarnessPointer(root, store);
    ptr.upgrade('hs-v1');

    createNodeSkillStore(root).writeSkill('local/loop', {
      category: 'x',
      title: 'loop',
      content: 'keep green',
    });
    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: true,
      nodes: [{ nodeInstId: 'n1', ref: 'local/loop', ok: true, entries: [] }],
      results: [],
    });

    const draft = reviseHarness(
      root,
      { patches: [{ path: 'entry.ts', action: 'write', content: 'export const mark = "v2";\n' }] },
      { store },
    );
    const gate = gateHarness(root, draft.id, { store });
    expect(gate.ok).toBe(true);
    ptr.upgrade(draft.id);

    const active = store.get(ptr.readActive()!.harnessId)!;
    expect(active.refs.loopTreeId).not.toBe(t0.treeId);
    const entryPath = resolveActiveLoopEntry(root, active.refs);
    expect(entryPath).toBeTruthy();
    expect(fs.readFileSync(entryPath!, 'utf8')).toContain('v2');
    // parent tree unchanged
    expect(trees.readFile(t0.treeId, 'entry.ts')).toContain('v1');
  });
});
