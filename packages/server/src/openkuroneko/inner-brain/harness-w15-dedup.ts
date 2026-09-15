/**
 * Suppress outer W15 ew_revision when inner Harness-RSI already owns the workflow (P3).
 * ADL: HARNESS-RSI.md §2.3 / §8 P3 — avoid double repair loops.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createHarnessPointer } from './harness-pointer.js';
import { createHarnessSpecStore } from './harness-spec-store.js';

function historicallyUpgraded(workDir: string, harnessId: string): boolean {
  const p = path.join(workDir, '.brain', 'harness', 'history.jsonl');
  if (!fs.existsSync(p)) return false;
  for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line) as { action?: string; to?: string };
      if (e.action === 'upgrade' && e.to === harnessId) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

/**
 * True when workspace active harness points at this workflow and was produced/upgraded by RSI.
 */
export function isHarnessRsiCoveringWorkflow(
  workDir: string,
  workflowId: string,
): boolean {
  try {
    const store = createHarnessSpecStore(workDir);
    const active = createHarnessPointer(workDir, store).readActive();
    if (!active) return false;
    const spec = store.get(active.harnessId);
    if (!spec?.refs.workflowRef?.id) return false;
    if (spec.refs.workflowRef.id !== workflowId.trim()) return false;
    if (spec.parentId) return true;
    return historicallyUpgraded(workDir, active.harnessId);
  } catch {
    return false;
  }
}
