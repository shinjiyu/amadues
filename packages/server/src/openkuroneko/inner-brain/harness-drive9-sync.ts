/**
 * Drive9 sync gate for harness-bound EW (P3).
 * Local promote always allowed; shared pool requires held-out pass when active H owns the EW.
 */

import { createHarnessPointer } from './harness-pointer.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { hasPassedHeldOut } from './harness-held-out.js';

export interface Drive9SyncGateResult {
  ok: boolean;
  reason: string;
  harnessId?: string;
}

/**
 * When workDir has an active harness whose workflowRef matches this EW,
 * require held-out pass before drive9 storeShared. Otherwise allow (no RSI context).
 */
export function maySyncWorkflowToDrive9(
  workDir: string | undefined,
  workflowId: string,
  version: string,
): Drive9SyncGateResult {
  if (!workDir?.trim()) {
    return { ok: true, reason: 'no_workDir' };
  }
  try {
    const store = createHarnessSpecStore(workDir);
    const active = createHarnessPointer(workDir, store).readActive();
    if (!active) return { ok: true, reason: 'no_active_harness' };
    const spec = store.get(active.harnessId);
    const ref = spec?.refs.workflowRef;
    if (!ref?.id) return { ok: true, reason: 'active_without_workflowRef' };
    if (ref.id !== workflowId.trim()) {
      return { ok: true, reason: 'workflow_not_owned_by_active_harness' };
    }
    // version may bump on promote; ownership is by workflow id
    if (hasPassedHeldOut(workDir, active.harnessId)) {
      return { ok: true, reason: 'held_out_passed', harnessId: active.harnessId };
    }
    return {
      ok: false,
      reason: `held_out_required:${active.harnessId}@${ref.id}@${version}`,
      harnessId: active.harnessId,
    };
  } catch (e) {
    return {
      ok: false,
      reason: `harness_gate_error:${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
