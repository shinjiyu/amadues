import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { suggestPromoteFromWorkspace } from './workflow-promote-suggest.js';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { validatePromoteDraft } from './workflow-promote.js';

describe('workflow-promote-suggest', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('发现 local_dag → frozen_dag 建议；不写 store', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-sug-'));
    const workDir = path.join(root, 'workspaces', 'task-abc');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.brain', 'local_dag.json'),
      JSON.stringify({
        nodes: [{ id: 'n1', ref: 'preset/base' }],
        entry: 'n1',
      }),
      'utf8',
    );

    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const before = store.list().length;
    const sug = suggestPromoteFromWorkspace(workDir, 'task-abc');
    expect(sug.length).toBeGreaterThanOrEqual(1);
    expect(sug[0]!.kind).toBe('frozen_dag');
    validatePromoteDraft(sug[0]!.draft);
    expect(store.list()).toHaveLength(before);
  });

  it('空目录 → 无建议', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-sug-empty-'));
    expect(suggestPromoteFromWorkspace(root)).toEqual([]);
  });
});
