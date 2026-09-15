/**
 * Post-ATTRIBUTE Harness-RSI cycle (P2).
 * revise → gate → upgrade → restart-with-H. Cap rounds. Auto only on failed RUN.
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §8 P2 / H3 / H8
 */

import type { HarnessSpecStore } from './harness-spec-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { reviseHarness } from './harness-revise.js';
import { gateHarness } from './harness-gate.js';
import { requestHarnessRestart } from './harness-restart.js';

export const HARNESS_RSI_MAX_ROUNDS = 2;

export interface HarnessRsiCycleInput {
  /** RUN 是否成功；P2 仅失败时自动 RSI */
  runOk: boolean;
  /** 当前 burst 已做 RSI 轮次（写在 dyflow-state） */
  rsiRound?: number;
  store?: HarnessSpecStore;
}

export type HarnessRsiCycleResult =
  | { applied: false; reason: string }
  | {
      applied: true;
      harnessId: string;
      parentId?: string;
      upgraded: boolean;
      restartRequested: boolean;
      reason: string;
    };

export function maybeApplyHarnessRsiCycle(
  workDir: string,
  input: HarnessRsiCycleInput,
): HarnessRsiCycleResult {
  if (input.runOk) {
    return { applied: false, reason: 'run_ok_skip' };
  }
  const round = input.rsiRound ?? 0;
  if (round >= HARNESS_RSI_MAX_ROUNDS) {
    return { applied: false, reason: 'rsi_cap' };
  }

  const store = input.store ?? createHarnessSpecStore(workDir);
  const ptr = createHarnessPointer(workDir, store);
  const before = ptr.readActive();

  let draft;
  try {
    draft = reviseHarness(workDir, {}, { store });
  } catch (e) {
    return {
      applied: false,
      reason: `revise_failed:${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parent = draft.parentId ? store.get(draft.parentId) : null;
  if (parent && parent.contentHash === draft.contentHash) {
    store.patchStatus(draft.id, 'rejected');
    return { applied: false, reason: 'noop_same_hash' };
  }

  const gate = gateHarness(workDir, draft.id, { store });
  if (!gate.ok) {
    return {
      applied: true,
      harnessId: draft.id,
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      upgraded: false,
      restartRequested: false,
      reason: `gated_fail:${gate.reasons.slice(0, 3).join(';')}`,
    };
  }

  ptr.upgrade(draft.id);
  const hadActive = Boolean(before);
  if (hadActive) {
    requestHarnessRestart(workDir, { store });
  }

  return {
    applied: true,
    harnessId: draft.id,
    ...(draft.parentId ? { parentId: draft.parentId } : {}),
    upgraded: true,
    restartRequested: hadActive,
    reason: hadActive ? 'upgraded_restart' : 'seeded_active',
  };
}
