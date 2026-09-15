/**
 * Auto held-out after a successful RUN when active H lacks a pass (P3 follow-up).
 * Enables drive9 sync without a manual gate call.
 */

import { createHarnessPointer } from './harness-pointer.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import {
  hasPassedHeldOut,
  runHeldOutGate,
  type HeldOutVerdict,
} from './harness-held-out.js';

export function maybeAutoHeldOutAfterSuccess(workDir: string): HeldOutVerdict | null {
  try {
    const store = createHarnessSpecStore(workDir);
    const active = createHarnessPointer(workDir, store).readActive();
    if (!active) return null;
    if (hasPassedHeldOut(workDir, active.harnessId)) return null;
    return runHeldOutGate(workDir, active.harnessId, {
      charterKind: 'same_kind',
      charterText: `auto-held-out:${active.harnessId}`,
    });
  } catch {
    return null;
  }
}
