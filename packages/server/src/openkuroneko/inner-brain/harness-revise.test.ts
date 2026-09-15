import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeRunContext } from './run-context-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { reviseHarness } from './harness-revise.js';
import { createNodeSkillStore } from './node-skill-store.js';

describe('harnessRevise', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rev-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('proposes a single H′ from active parent + run-context node refs (H8)', () => {
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-a',
      refs: { localNodeIds: ['local/old'], workflowRef: { id: 'w', version: '1' } },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-a');
    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      nodes: [
        { nodeInstId: 'n1', ref: 'local/login', ok: false, entries: [] },
        { nodeInstId: 'n2', ref: 'local/login', ok: true, entries: [] },
      ],
      results: [],
    });
    const next = reviseHarness(root, {}, { store });
    expect(next.parentId).toBe('hs-a');
    expect(next.status).toBe('draft');
    expect(next.id).not.toBe('hs-a');
    expect(next.refs.localNodeIds).toContain('local/login');
    expect(next.refs.workflowRef).toEqual({ id: 'w', version: '1' });
    expect(store.list().filter((s) => s.status === 'draft')).toHaveLength(1);
  });

  it('rejects diagnosis that leaks x_eval / KPI rubric (H6)', () => {
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-a', refs: {}, status: 'gated_ok' });
    createHarnessPointer(root, store).upgrade('hs-a');
    expect(() =>
      reviseHarness(root, { diagnosis: 'optimize for x_eval pairwise win' }, { store }),
    ).toThrow(/H6/);
    expect(store.list()).toHaveLength(1);
  });

  it('pulls skillRefs from run-context nodes (failed nodes first)', () => {
    const skillStore = createNodeSkillStore(root);
    const okSkill = skillStore.writeSkill('local/ok', {
      category: 'x',
      title: 'Ok skill',
      content: 'ok steps',
    });
    const failSkill = skillStore.writeSkill('local/fail', {
      category: 'y',
      title: 'Fail skill',
      content: 'fail steps',
    });
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-a', refs: { localNodeIds: ['local/ok'] }, status: 'gated_ok' });
    createHarnessPointer(root, store).upgrade('hs-a');
    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      nodes: [
        { nodeInstId: 'n-ok', ref: 'local/ok', ok: true, entries: [] },
        { nodeInstId: 'n-fail', ref: 'local/fail', ok: false, entries: [] },
      ],
      results: [],
    });
    const next = reviseHarness(root, {}, { store });
    expect(next.refs.skillRefs?.[0]).toEqual({
      nodeRef: 'local/fail',
      skillId: failSkill.ref.id,
    });
    expect(next.refs.skillRefs?.some((s) => s.skillId === okSkill.ref.id)).toBe(true);
  });
});
