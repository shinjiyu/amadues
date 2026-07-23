import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import {
  promoteWorkflow,
  validatePromoteDraft,
  WorkflowPromoteError,
} from './workflow-promote.js';
import type { PromoteWorkflowInput } from './workflow-promote.js';

describe('workflow-promote', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  const base = (): PromoteWorkflowInput => ({
    id: 'ew-pub',
    kind: 'skill_md',
    title: 'Publish',
    steps: [
      { id: 'a', action: 'skill_step', expect: { fileExists: 'a.md' } },
      { id: 'b', action: 'assert', expect: { stdoutContains: 'ok' } },
    ],
  });

  it('拒收无机械 expect 的步骤 (W3)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [{ id: 'x', action: 'assert', expect: { note: 'only note' } }],
      }),
    ).toThrow(WorkflowPromoteError);
  });

  it('promote bumps version', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-promote-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const v1 = promoteWorkflow(store, base());
    expect(v1.version).toBe('1');
    const v2 = promoteWorkflow(store, { ...base(), title: 'Publish2' });
    expect(v2.version).toBe('2');
    expect(store.getLatest('ew-pub')?.title).toBe('Publish2');
  });

  it('promote 可同步 drive9', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-promote-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const shared: unknown[] = [];
    const drive9 = { storeShared: (wf: unknown) => { shared.push(wf); } } as import('../drive9/workflow-drive9-store.js').WorkflowDrive9Store;
    promoteWorkflow(store, base(), { drive9 });
    expect(shared).toHaveLength(1);
  });
});
