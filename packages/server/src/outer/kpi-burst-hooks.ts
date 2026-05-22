/**
 * KPI 与 burst 之间的桥接 hook —— 在 burst 子进程退出时调用，把"这一轮发生了什么"
 * 折回到 KpiRegistry，并在 idle streak 达阈值时触发反思 burst。
 *
 * 设计：纯函数 + 显式依赖注入（KpiRegistry / InnerBrainRegistry / scheduleReflexionBurst）。
 * 之所以抽出来：outer-tools.ts 的 execSetGoal 和 index.ts 的 spawnAndAttachWorker 都
 * 自己挂了 onExit，需要共享同一套 KPI 进度更新逻辑——重复粘贴会失去同步。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KpiRegistry, ReflexionSummary } from './kpi-registry.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { buildBrainAsyncSnapshot } from './brain-async-snapshot.js';
import { shouldAutoAchieveKpi } from './kpi-progress.js';

/** 读取 burst 工作目录下 reflexion.json 并标准化为 ReflexionSummary */
export function readReflexionFromWorkspace(
  workDir: string,
  burstInstanceId: string,
): ReflexionSummary | null {
  const p = path.join(workDir, '.brain', 'reflexion.json');
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const verdictRaw = String(raw['verdict'] ?? 'failed').toLowerCase();
    const verdict: ReflexionSummary['verdict'] =
      verdictRaw === 'success' || verdictRaw === 'partial' ? verdictRaw : 'failed';
    return {
      ts: new Date().toISOString(),
      burstInstanceId,
      verdict,
      hardFailures: Array.isArray(raw['hardFailures'])
        ? (raw['hardFailures'] as unknown[]).map(String).slice(0, 10) : [],
      softFailures: Array.isArray(raw['softFailures'])
        ? (raw['softFailures'] as unknown[]).map(String).slice(0, 10) : [],
      nextStrategy: String(raw['nextStrategy'] ?? '').trim(),
    };
  } catch {
    return null;
  }
}

/**
 * 是否应将本次 burst 计为 KPI「无进展」（用于 consecutiveIdleBursts）。
 * 优先看 reflexion.verdict；无 reflexion 时回退到 idle + 零 deliverable。
 */
export function shouldRecordKpiIdle(input: {
  exitedWithError: boolean;
  stoppedBy: string;
  deliverableCount: number;
  reflexion: ReflexionSummary | null;
  /** 是否处于 AWAITING（等外部事件）。等外部不算 idle 不算进展，需要单独处理 */
  isAwaiting?: boolean;
}): boolean {
  if (input.exitedWithError) return true;

  // AWAITING:agent 等待外部输入,而非"卡死"——既不算 idle 也不算成功
  // 不增 streak（保留当前 streak）
  if (input.isAwaiting) return false;

  if (input.reflexion) {
    if (input.reflexion.verdict === 'failed') return true;
    if (input.reflexion.verdict === 'success') return false;
    return input.deliverableCount === 0;
  }

  return input.stoppedBy === 'idle' && input.deliverableCount === 0;
}

/** 读取 deliverables.json 条目数（位于 <workDir>/.run/pi-mono/deliverables.json） */
export function countDeliverables(workDir: string): number {
  const p = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    if (!fs.existsSync(p)) return 0;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

export interface BurstExitInput {
  instanceId: string;
  kpiId?: string;
  isReflexionBurst?: boolean;
  workDir: string;
  stoppedBy: 'idle' | 'max_ticks' | 'stop_signal' | string;
  exitedWithError: boolean;
  /** 是否处于 AWAITING（active pendings 仍在等外部）；用于跳过 idle streak */
  isAwaiting?: boolean;
}

export interface BurstExitDeps {
  kpiRegistry: KpiRegistry;
  innerBrainRegistry: InnerBrainRegistry;
  /** 派发反思 burst 的函数（注入避免 index.ts ↔ outer 循环依赖） */
  scheduleReflexionBurst: (kpiId: string) => string | null;
  /** meta 反思结束后自动派下一发真任务（UTLRA_KPI_AUTO_NEXT_BURST=1） */
  scheduleNextKpiBurst?: (kpiId: string) => string | null;
  /** 反思 burst 触发阈值；默认 UTLRA_KPI_STUCK_THRESHOLD or 3 */
  stuckThreshold?: number;
}

export interface BurstExitOutcome {
  deliverableCount: number;
  reflexion: ReflexionSummary | null;
  /** 若本次触发了反思 burst，这里是它的 instanceId */
  reflexionBurstId: string | null;
  /** meta 反思后自动派发的下一发真 burst（可选） */
  nextKpiBurstId?: string | null;
  /** KPI 当前的连续 idle streak（更新后） */
  idleStreak: number;
  /** 本次 burst 退出后是否已自动 markAchieved */
  autoAchieved?: boolean;
}

function isKpiAutoNextBurstEnabled(): boolean {
  const raw = process.env['UTLRA_KPI_AUTO_NEXT_BURST']?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * burst 子进程退出后必须调用。
 *
 * 副作用：
 *   1. 把 reflexion.json 解析为 ReflexionSummary 追加到 KpiRegistry.trail
 *   2. 根据 stoppedBy + deliverableCount 更新 KPI.consecutiveIdleBursts
 *   3. 如果 idleStreak 达阈值 且 KPI 还 active → 派反思 burst
 *
 * 反思 burst 自身（isReflexionBurst=true）跳过上述所有逻辑——它不应触发新的反思 burst。
 * 非 KPI 关联的 burst（kpiId 为空）也跳过——所有逻辑只对挂 KPI 的"真任务"生效。
 */
export function processBurstExitForKpi(
  input: BurstExitInput,
  deps: BurstExitDeps,
): BurstExitOutcome {
  const deliverableCount = countDeliverables(input.workDir);
  const reflexion = readReflexionFromWorkspace(input.workDir, input.instanceId);

  if (!input.kpiId) {
    return { deliverableCount, reflexion, reflexionBurstId: null, idleStreak: 0 };
  }

  // 1) 反思回流（含 meta reflexion burst）
  if (reflexion) {
    deps.kpiRegistry.appendReflexion(input.kpiId, reflexion);
  }

  const kpi = deps.kpiRegistry.get(input.kpiId);
  const currentStreak = kpi?.consecutiveIdleBursts ?? 0;

  // meta 反思 burst：写 trail；可选自动派下一发真任务；不累计 idle、不触发 meta-of-meta
  if (input.isReflexionBurst) {
    let nextKpiBurstId: string | null = null;
    if (
      reflexion &&
      deps.scheduleNextKpiBurst &&
      isKpiAutoNextBurstEnabled() &&
      kpi?.status === 'active'
    ) {
      nextKpiBurstId = deps.scheduleNextKpiBurst(input.kpiId);
    }
    return {
      deliverableCount,
      reflexion,
      reflexionBurstId: null,
      nextKpiBurstId,
      idleStreak: currentStreak,
    };
  }

  // 2) Idle streak
  let streak = currentStreak;
  if (input.isAwaiting) {
    // AWAITING: 维持当前 streak,不增不减(等外部回复期间 KPI 进展不变)
    streak = currentStreak;
  } else if (shouldRecordKpiIdle({ exitedWithError: input.exitedWithError, stoppedBy: input.stoppedBy, deliverableCount, reflexion })) {
    streak = deps.kpiRegistry.recordIdle(input.kpiId);
  } else {
    deps.kpiRegistry.resetIdle(input.kpiId);
    streak = 0;
  }

  // 3) 达阈值 → 派反思 burst
  let reflexionBurstId: string | null = null;
  const threshold = deps.stuckThreshold ?? Math.max(1, Number(process.env['UTLRA_KPI_STUCK_THRESHOLD'] ?? 3));
  if (streak >= threshold && kpi?.status === 'active') {
    reflexionBurstId = deps.scheduleReflexionBurst(input.kpiId);
  }

  // 4) 里程碑全完成 + 有产出 → 自动 achieved（外脑常忘记调 achieve_kpi）
  let autoAchieved = false;
  const snap = buildBrainAsyncSnapshot(input.workDir);
  const kpiNow = deps.kpiRegistry.get(input.kpiId);
  if (
    kpiNow?.status === 'active' &&
    shouldAutoAchieveKpi({
      reflexion,
      deliverableCount,
      isAwaiting: input.isAwaiting ?? false,
      exitedWithError: input.exitedWithError,
      isPostComplete: snap.is_post_complete,
    })
  ) {
    deps.kpiRegistry.markAchieved(
      input.kpiId,
      `自动达成：burst ${input.instanceId} 已完成里程碑，产出 ${deliverableCount} 项`,
    );
    autoAchieved = true;
  }

  return {
    deliverableCount,
    reflexion,
    reflexionBurstId,
    nextKpiBurstId: null,
    idleStreak: streak,
    autoAchieved,
  };
}
