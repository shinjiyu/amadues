import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gateBurstMode, isRedesignAllowed, normalizeBurstMode } from './burst-mode-gate.js';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { promoteWorkflow } from './workflow-promote.js';

describe('burst-mode-gate', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('缺省 explore', () => {
    expect(normalizeBurstMode(undefined)).toBe('explore');
    const r = gateBurstMode({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.burstMode).toBe('explore');
  });

  it('execute 缺 workflowRef 拒收', () => {
    const r = gateBurstMode({ burstMode: 'execute' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/workflowRef/);
  });

  it('execute + 存在的 ref 通过；paused 拒收', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-gate-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    promoteWorkflow(store, {
      id: 'ew-x',
      kind: 'shell_pipeline',
      title: 'X',
      steps: [{ id: 's', action: 'assert', expect: { fileExists: 'f' } }],
    });
    const ok = gateBurstMode({
      burstMode: 'execute',
      workflowRef: { id: 'ew-x', version: '1' },
      store,
    });
    expect(ok.ok).toBe(true);

    store.setPaused('ew-x', true);
    const bad = gateBurstMode({
      burstMode: 'execute',
      workflowRef: { id: 'ew-x', version: '1' },
      store,
    });
    expect(bad.ok).toBe(false);
  });

  it('isRedesignAllowed', () => {
    expect(isRedesignAllowed('explore')).toBe(true);
    expect(isRedesignAllowed('execute')).toBe(false);
  });
});
