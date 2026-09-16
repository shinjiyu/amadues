/**
 * Post-ATTRIBUTE Harness-RSI cycle (P4).
 * Primary: cadence analyze → revise → gate → upgrade.
 * Auxiliary: hard fail may enter immediately.
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §4 / §8 P4 / H3 / H8 / H9
 */

import type { HarnessSpecStore } from './harness-spec-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { reviseHarness } from './harness-revise.js';
import { gateHarness } from './harness-gate.js';
import { requestHarnessRestart } from './harness-restart.js';
import { analyzeHarness } from './harness-analyze.js';
import type { HarnessPatch } from './harness-types.js';

export const HARNESS_RSI_MAX_ROUNDS = 2;

export interface HarnessRsiCycleInput {
  /** RUN 是否成功；失败走辅触发，成功仍累计 cadence */
  runOk: boolean;
  /** 当前 burst 已做 RSI 轮次（写在 dyflow-state） */
  rsiRound?: number;
  /** Override analyze interval (tests) */
  analyzeInterval?: number;
  forceAnalyze?: boolean;
  store?: HarnessSpecStore;
  /** P5: optional patches for revise (loop source evolution) */
  patches?: HarnessPatch[];
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
      trigger?: string;
    };

export function maybeApplyHarnessRsiCycle(
  workDir: string,
  input: HarnessRsiCycleInput,
): HarnessRsiCycleResult {
  const round = input.rsiRound ?? 0;
  if (round >= HARNESS_RSI_MAX_ROUNDS) {
    return { applied: false, reason: 'rsi_cap' };
  }

  const analysis = analyzeHarness(workDir, {
    runOk: input.runOk,
    force: input.forceAnalyze || Boolean(input.patches?.length),
    interval: input.analyzeInterval,
  });

  // P5: patches themselves are substantive (H12); do not require soft findings to apply them.
  if (!analysis.shouldRevise && !input.patches?.length) {
    return { applied: false, reason: analysis.reason };
  }

  const store = input.store ?? createHarnessSpecStore(workDir);
  const ptr = createHarnessPointer(workDir, store);
  const before = ptr.readActive();

  let draft;
  try {
    draft = reviseHarness(
      workDir,
      {
        ...(analysis.diagnosis
          ? { diagnosis: analysis.diagnosis }
          : input.patches?.length
            ? { diagnosis: 'loop_source_patches' }
            : {}),
        ...(input.patches?.length ? { patches: input.patches } : {}),
      },
      { store },
    );
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
      trigger: analysis.trigger,
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
    trigger: analysis.trigger,
  };
}
