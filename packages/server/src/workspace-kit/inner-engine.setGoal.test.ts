import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { InnerBrainEngine } from './inner-engine.js';
import { FilesystemWorkspaceStore } from './workspace-store.js';

describe('InnerBrainEngine.setGoal (DyFlow)', () => {
  let dataRoot = '';
  let store: FilesystemWorkspaceStore;
  const workspaceId = 'task-ib-test-001';

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-eng-'));
    store = new FilesystemWorkspaceStore(dataRoot);
  });

  afterEach(() => {
    if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('seeds dyflow DESIGN and never writes planning phase', () => {
    const eng = new InnerBrainEngine(store, workspaceId);
    eng.setGoal('爬取点评数据并汇总');

    const wd = store.resolveWorkDir(workspaceId);
    const status = JSON.parse(
      fs.readFileSync(path.join(wd, '.run', 'status.json'), 'utf8'),
    ) as { phase: string; lastAction: string | null };
    const dyflow = JSON.parse(
      fs.readFileSync(path.join(wd, '.brain', 'dyflow-state.json'), 'utf8'),
    ) as { mode: string };

    expect(status.phase).toBe('executing');
    expect(status.phase).not.toBe('planning');
    expect(status.lastAction).toContain('dyflow:DESIGN');
    expect(dyflow.mode).toBe('DESIGN');
    expect(fs.existsSync(path.join(wd, '.brain', 'controller-state.json'))).toBe(false);
  });
});
