/**
 * Held-out charter gate before drive9 sync (P3).
 * ADL: doc/structurizr/HARNESS-RSI.md §5 / §8 P3
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { WorkflowStepExpect } from '../../outer/executable-workflow-types.js';
import { checkExpect } from './workflow-runner.js';
import { createHarnessSpecStore } from './harness-spec-store.js';

export interface HeldOutVerdict {
  harnessId: string;
  /** e.g. same_kind — held-out charter family */
  charterKind: string;
  fingerprint: string;
  passed: boolean;
  reasons: string[];
  at: string;
}

function heldOutDir(workDir: string): string {
  return path.join(workDir, '.brain', 'harness', 'held-out');
}

function verdictPath(workDir: string, harnessId: string): string {
  return path.join(heldOutDir(workDir), `${harnessId}.json`);
}

export function fingerprintCharter(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

export function recordHeldOutVerdict(workDir: string, verdict: HeldOutVerdict): void {
  fs.mkdirSync(heldOutDir(workDir), { recursive: true });
  fs.writeFileSync(
    verdictPath(workDir, verdict.harnessId),
    `${JSON.stringify(verdict, null, 2)}\n`,
    'utf8',
  );
}

export function readHeldOutVerdict(workDir: string, harnessId: string): HeldOutVerdict | null {
  const p = verdictPath(workDir, harnessId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as HeldOutVerdict;
  } catch {
    return null;
  }
}

export function hasPassedHeldOut(
  workDir: string,
  harnessId: string,
  charterKind = 'same_kind',
): boolean {
  const v = readHeldOutVerdict(workDir, harnessId);
  return Boolean(v && v.passed && v.charterKind === charterKind);
}

/**
 * Mechanical held-out: run expects (default: active H assetPaths) against workDir.
 * Does not touch active pointer.
 */
export function runHeldOutGate(
  workDir: string,
  harnessId: string,
  opts?: {
    charterKind?: string;
    charterText?: string;
    expects?: WorkflowStepExpect[];
  },
): HeldOutVerdict {
  const store = createHarnessSpecStore(workDir);
  const spec = store.get(harnessId);
  if (!spec) throw new Error(`[harness-held-out] missing spec ${harnessId}`);

  const expects =
    opts?.expects ??
    (spec.refs.assetPaths ?? []).map((fileExists) => ({ fileExists }));
  const reasons: string[] = [];
  for (const exp of expects) {
    const r = checkExpect(exp, { workDir });
    if (!r.ok) reasons.push(r.detail);
  }
  const charterText = opts?.charterText?.trim() || `held-out:${harnessId}`;
  const verdict: HeldOutVerdict = {
    harnessId,
    charterKind: opts?.charterKind ?? 'same_kind',
    fingerprint: fingerprintCharter(charterText),
    passed: reasons.length === 0,
    reasons,
    at: new Date().toISOString(),
  };
  recordHeldOutVerdict(workDir, verdict);
  return verdict;
}
