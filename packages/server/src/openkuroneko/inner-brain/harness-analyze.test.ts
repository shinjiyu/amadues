import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeRunContext } from './run-context-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { createNodeSkillStore } from './node-skill-store.js';
import {
  analyzeHarness,
  collectHarnessFindings,
  DEFAULT_ANALYZE_INTERVAL,
  HEAVY_REACT_ENTRY_THRESHOLD,
  readAnalyzeCadence,
  tickAnalyzeCadence,
} from './harness-analyze.js';

describe('harnessAnalyze', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-an-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('ticks cadence and is due every interval', () => {
    expect(tickAnalyzeCadence(root, { interval: 3 }).due).toBe(false);
    expect(tickAnalyzeCadence(root, { interval: 3 }).due).toBe(false);
    expect(tickAnalyzeCadence(root, { interval: 3 }).due).toBe(true);
    expect(readAnalyzeCadence(root).attributeCount).toBe(3);
    expect(readAnalyzeCadence(root).interval).toBe(3);
  });

  it('collects unbound_skills and heavy_react soft findings', () => {
    const skillStore = createNodeSkillStore(root);
    skillStore.writeSkill('local/a', {
      category: 'x',
      title: 't',
      content: 'c',
    });
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-1', refs: { localNodeIds: ['local/a'] }, status: 'gated_ok' });
    createHarnessPointer(root, store).upgrade('hs-1');

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

    const findings = collectHarnessFindings(root, true);
    expect(findings.some((f) => f.code === 'unbound_skills')).toBe(true);
    expect(findings.some((f) => f.code === 'heavy_react')).toBe(true);
  });

  it('skips revise when success and cadence not due', () => {
    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: true,
      nodes: [],
      results: [],
    });
    const r = analyzeHarness(root, { runOk: true, interval: DEFAULT_ANALYZE_INTERVAL });
    expect(r.shouldRevise).toBe(false);
    expect(r.reason).toBe('cadence_wait');
    expect(r.trigger).toBe('skipped');
  });

  it('hard fail may revise even before cadence', () => {
    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      failedAt: 'n1',
      nodes: [{ nodeInstId: 'n1', ref: 'local/x', ok: false, entries: [] }],
      results: [],
    });
    const r = analyzeHarness(root, { runOk: false, interval: 99 });
    expect(r.shouldRevise).toBe(true);
    expect(r.trigger).toBe('hard_fail');
    expect(r.findings.some((f) => f.code === 'hard_fail')).toBe(true);
  });

  it('open_sorry alone does not force revise on success', () => {
    fs.mkdirSync(path.join(root, 'Collatz'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'Collatz', 'Conjecture.lean'),
      'theorem conjecture : True := by sorry\n',
      'utf8',
    );
    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: true,
      nodes: [{ nodeInstId: 'n1', ref: 'local/clean', ok: true, entries: [] }],
      results: [],
    });
    const r = analyzeHarness(root, { runOk: true, interval: 1 });
    expect(r.findings.some((f) => f.code === 'open_sorry')).toBe(true);
    expect(r.shouldRevise).toBe(false);
    expect(r.reason).toBe('no_findings');
  });
});
