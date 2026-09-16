import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeRunContext } from './run-context-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { createNodeSkillStore } from './node-skill-store.js';
import { maybeApplyHarnessRsiCycle } from './harness-rsi-cycle.js';
import { HEAVY_REACT_ENTRY_THRESHOLD } from './harness-analyze.js';
import { writeAnalyzeCadence } from './harness-analyze.js';

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

function writeOkHeavyWithUnboundSkill(root: string): void {
  createNodeSkillStore(root).writeSkill('local/a', {
    category: 'x',
    title: 't',
    content: 'c',
  });
  const heavy = Array.from({ length: HEAVY_REACT_ENTRY_THRESHOLD }, (_, i) => ({
    toolName: `t${i}`,
    args: {},
    result: { ok: true },
  }));
  writeRunContext(root, {
    burstId: 'b1',
    designedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ok: true,
    nodes: [
      {
        nodeInstId: 'n1',
        ref: 'local/a',
        ok: true,
        entries: heavy as never[],
      },
    ],
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

  it('waits cadence on success without due interval', () => {
    writeOkHeavyWithUnboundSkill(root);
    const r = maybeApplyHarnessRsiCycle(root, { runOk: true, analyzeInterval: 3 });
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('cadence_wait');
  });

  it('on cadence due with soft findings: revise→upgrade even if runOk', () => {
    writeAnalyzeCadence(root, { attributeCount: 2, interval: 3 });
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-old',
      refs: { localNodeIds: ['local/old'] },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-old');
    writeOkHeavyWithUnboundSkill(root);

    const r = maybeApplyHarnessRsiCycle(root, {
      runOk: true,
      store,
      analyzeInterval: 3,
    });
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.upgraded).toBe(true);
      expect(r.restartRequested).toBe(true);
      expect(r.trigger).toBe('cadence');
    }
    expect(createHarnessPointer(root, store).readActive()?.harnessId).not.toBe('hs-old');
  });

  it('success + cadence due + no findings → skip', () => {
    writeAnalyzeCadence(root, { attributeCount: 2, interval: 3 });
    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: true,
      nodes: [{ nodeInstId: 'n1', ref: 'local/clean', ok: true, entries: [] }],
      results: [],
    });
    const r = maybeApplyHarnessRsiCycle(root, { runOk: true, analyzeInterval: 3 });
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('no_findings');
  });

  it('hard fail still seeds/upgrades without waiting cadence', () => {
    writeFailedCtx(root, ['local/a']);
    const store = createHarnessSpecStore(root);
    const r = maybeApplyHarnessRsiCycle(root, {
      runOk: false,
      store,
      analyzeInterval: 99,
    });
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.upgraded).toBe(true);
      expect(r.restartRequested).toBe(false);
      expect(r.reason).toBe('seeded_active');
      expect(r.trigger).toBe('hard_fail');
    }
    expect(createHarnessPointer(root, store).readActive()?.harnessId).toBeTruthy();
  });

  it('upgrades and requests restart when H′ differs from active (fail path)', () => {
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
    expect(fs.existsSync(path.join(root, '.brain', 'harness', 'restart-requested.json'))).toBe(
      true,
    );
  });

  it('respects rsi cap', () => {
    writeFailedCtx(root, ['local/a']);
    const r = maybeApplyHarnessRsiCycle(root, { runOk: false, rsiRound: 2 });
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('rsi_cap');
  });
});
