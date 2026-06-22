/**
 * AWAITING burst 审查 — ADL KPI-MANAGER-LAYER.md §3.1 R3/R4
 */
import fs from 'node:fs';
import path from 'node:path';

import { listActivePendings } from '../../openkuroneko/pendings/index.js';
import { buildBrainAsyncSnapshot } from '../brain-async-snapshot.js';
import type { TaskRecord } from '../inner-brain-registry.js';
import { stopInnerBrainInstance } from '../stop-inner-brain.js';
import type { KpiManagerDeps } from './kpi-manager.js';
import {
  classifyAwaitingWithLlm,
  type AwaitingReviewLlmCaller,
} from './kpi-awaiting-review-llm.js';
import {
  DEFAULT_STALE_AWAITING_POLICY,
  type StaleAwaitingPolicy,
} from './kpi-awaiting-policy.js';
import { selectNeedsReview } from './stale-burst-reaper.js';

export const DEFAULT_ASK_USER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TIMER_GRACE_MS = 5 * 60 * 1000;

export interface AwaitingReviewResult {
  stopped: string[];
  reasons: Record<string, string>;
}

export interface AwaitingReviewOptions {
  askUserTimeoutMs?: number;
  nowMs?: number;
  staleAwaitingPolicy?: StaleAwaitingPolicy;
  callLlm?: AwaitingReviewLlmCaller;
}

function awaitingSinceMs(rec: TaskRecord): number {
  const ref = rec.lastTickAt ?? rec.startedAt;
  const ms = Date.parse(ref);
  return Number.isFinite(ms) ? ms : Date.now();
}

function readDyflowMode(workDir: string): string | null {
  const fp = path.join(workDir, '.brain', 'dyflow-state.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as { mode?: string };
    return typeof raw.mode === 'string' ? raw.mode : null;
  } catch {
    return null;
  }
}

function isUnreasonableAwaiting(rec: TaskRecord, nowMs: number): string | null {
  const snap = buildBrainAsyncSnapshot(rec.workDir);
  const brainDir = path.join(rec.workDir, '.brain');
  const pendings = fs.existsSync(path.join(brainDir, 'pendings.json'))
    ? listActivePendings(brainDir)
    : [];

  if (snap.has_ask_user_pending) return null;

  if (rec.status === 'AWAITING' && pendings.length === 0 && !snap.is_post_complete) {
    const dyflowMode = readDyflowMode(rec.workDir);
    if (dyflowMode === 'AWAITING' || snap.controller.mode === 'AWAITING') {
      return 'awaiting_no_pendings';
    }
  }

  for (const p of pendings) {
    if (p.kind !== 'timer') continue;
    const spec = p.spec as { execute_at?: string };
    const at = spec.execute_at ? Date.parse(spec.execute_at) : NaN;
    if (Number.isFinite(at) && nowMs > at + TIMER_GRACE_MS) {
      return 'timer_overdue';
    }
  }

  return null;
}

function isAskUserTimedOut(rec: TaskRecord, timeoutMs: number, nowMs: number): boolean {
  const snap = buildBrainAsyncSnapshot(rec.workDir);
  if (!snap.has_ask_user_pending) return false;
  return nowMs - awaitingSinceMs(rec) > timeoutMs;
}

function stopIfNeeded(
  rec: TaskRecord,
  registry: KpiManagerDeps['registry'],
  reason: string,
  stopped: string[],
  reasons: Record<string, string>,
): void {
  stopInnerBrainInstance(rec, registry, `kpi_manager:${reason}`);
  const updated = registry.get(rec.instanceId);
  if (updated?.status === 'STOPPED' || updated?.status === 'DONE') {
    stopped.push(rec.instanceId);
    reasons[rec.instanceId] = reason;
  }
}

/**
 * R3：不合理 AWAITING → stop；R4：ask_user 超时 → stop。
 * P3：超 requireProgressSignalAfterMs 且无确定性结论时，可选 LLM 复审。
 */
export async function reviewAwaitingBursts(
  deps: Pick<KpiManagerDeps, 'registry' | 'dataRoot'>,
  opts: AwaitingReviewOptions = {},
): Promise<AwaitingReviewResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const askTimeout = opts.askUserTimeoutMs ?? DEFAULT_ASK_USER_TIMEOUT_MS;
  const policy = opts.staleAwaitingPolicy ?? DEFAULT_STALE_AWAITING_POLICY;
  const stopped: string[] = [];
  const reasons: Record<string, string> = {};

  const awaitingTasks = deps.registry.list().filter((t) => t.status === 'AWAITING');
  const needsLlmReview = new Set(
    selectNeedsReview(awaitingTasks, policy, nowMs),
  );

  for (const rec of awaitingTasks) {
    if (isAskUserTimedOut(rec, askTimeout, nowMs)) {
      stopIfNeeded(rec, deps.registry, 'ask_user_timeout', stopped, reasons);
      continue;
    }

    const deterministic = isUnreasonableAwaiting(rec, nowMs);
    if (deterministic) {
      stopIfNeeded(rec, deps.registry, deterministic, stopped, reasons);
      continue;
    }

    if (!opts.callLlm || !needsLlmReview.has(rec.instanceId)) continue;

    const snap = buildBrainAsyncSnapshot(rec.workDir);
    const verdict = await classifyAwaitingWithLlm(rec, snap, opts.callLlm);
    if (verdict && !verdict.reasonable) {
      stopIfNeeded(
        rec,
        deps.registry,
        verdict.reason ? `llm_awaiting:${verdict.reason.slice(0, 80)}` : 'llm_awaiting_unreasonable',
        stopped,
        reasons,
      );
    }
  }

  return { stopped, reasons };
}
