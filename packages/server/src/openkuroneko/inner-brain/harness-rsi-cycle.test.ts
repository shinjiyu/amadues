import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeRunContext } from './run-context-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { maybeApplyHarnessRsiCycle } from './harness-rsi-cycle.js';

function writeFailedCtx(root: string, refs: string[]): void {
  writeRunContext(root, {
    burstId: 'b1',
    designedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ok: false,
    failedAt: 'n1',
    nodes: refs.map((ref, i) => ({
      nodeInstId: `n${i}`,
      ref,
      ok: false,
      entries: [],
    })),
    results: [],
  });
}

describe('maybeApplyHarnessRsiCycle', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cycle-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('skips when runOk', () => {
    const r = maybeApplyHarnessRsiCycle(root, { runOk: true });
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('run_ok_skip');
  });

  it('seeds first active from run-context without restart', () => {
    writeFailedCtx(root, ['local/a']);
    const store = createHarnessSpecStore(root);
    const r = maybeApplyHarnessRsiCycle(root, { runOk: false, store });
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.upgraded).toBe(true);
      expect(r.restartRequested).toBe(false);
      expect(r.reason).toBe('seeded_active');
    }
    expect(createHarnessPointer(root, store).readActive()?.harnessId).toBeTruthy();
  });

  it('upgrades and requests restart when H′ differs from active', () => {
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-old',
      refs: { localNodeIds: ['local/old'] },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-old');
    writeFailedCtx(root, ['local/new']);
    const r = maybeApplyHarnessRsiCycle(root, { runOk: false, store });
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.restartRequested).toBe(true);
      expect(r.upgraded).toBe(true);
    }
    expect(createHarnessPointer(root, store).readActive()?.harnessId).not.toBe('hs-old');
    expect(fs.existsSync(path.join(root, '.brain', 'harness', 'restart-requested.json'))).toBe(true);
  });

  it('respects rsi cap', () => {
    writeFailedCtx(root, ['local/a']);
    const r = maybeApplyHarnessRsiCycle(root, { runOk: false, rsiRound: 2 });
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('rsi_cap');
  });
});
