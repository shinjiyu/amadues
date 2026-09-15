/**
 * Mechanical harness gate — EW expect / asset fixtures; fail leaves active unchanged.
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §4 / H3
 */

import fs from 'node:fs';
import path from 'node:path';

import type { WorkflowStepExpect } from '../../outer/executable-workflow-types.js';
import { checkExpect } from './workflow-runner.js';
import type { HarnessSpecStore } from './harness-spec-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import type { HarnessRefs } from './harness-types.js';

export interface HarnessGateResult {
  ok: boolean;
  harnessId: string;
  reasons: string[];
}

export interface HarnessGateOpts {
  store?: HarnessSpecStore;
}

function fixturesPath(workDir: string): string {
  return path.join(workDir, '.brain', 'harness', 'fixtures', 'gate.json');
}

function expectsFromRefs(refs: HarnessRefs): WorkflowStepExpect[] {
  return (refs.assetPaths ?? []).map((fileExists) => ({ fileExists }));
}

function loadFixtureExpects(workDir: string): WorkflowStepExpect[] {
  const p = fixturesPath(workDir);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { expects?: WorkflowStepExpect[] };
    return Array.isArray(raw.expects) ? raw.expects : [];
  } catch {
    return [];
  }
}

function runExpects(
  workDir: string,
  expects: WorkflowStepExpect[],
  prefix: string,
): string[] {
  const reasons: string[] = [];
  for (const exp of expects) {
    const r = checkExpect(exp, { workDir });
    if (!r.ok) reasons.push(`${prefix}${r.detail}`);
  }
  return reasons;
}

export function gateHarness(
  workDir: string,
  harnessId: string,
  opts: HarnessGateOpts = {},
): HarnessGateResult {
  const store = opts.store ?? createHarnessSpecStore(workDir);
  const spec = store.get(harnessId);
  if (!spec) throw new Error(`[harness-gate] missing spec ${harnessId}`);

  const reasons: string[] = [];
  reasons.push(...runExpects(workDir, expectsFromRefs(spec.refs), ''));
  reasons.push(...runExpects(workDir, loadFixtureExpects(workDir), 'fixture: '));

  if (spec.parentId) {
    const parent = store.get(spec.parentId);
    if (parent) {
      reasons.push(
        ...runExpects(workDir, expectsFromRefs(parent.refs), 'parent regression: '),
      );
    }
  }

  const ok = reasons.length === 0;
  store.patchStatus(harnessId, ok ? 'gated_ok' : 'gated_fail');
  return { ok, harnessId, reasons };
}
