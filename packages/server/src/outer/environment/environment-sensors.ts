/**
 * 环境模型 — 内置 sensor（ADL ENVIRONMENT-MODEL.md §8 P0/P1）。
 *
 * 这些 sensor 的 read() 输出与旧 resourceProbe 的字段**数值一致**，
 * 以便 toResourceSnapshot 适配器零行为差地喂给现有 autonomyJudge / dispatcher。
 *
 * sensor 只读、deterministic（除墙钟由 ctx.now 注入）、禁 LLM / 禁阻塞 IO。
 */
import { buildBrainAsyncSnapshot } from '../brain-async-snapshot.js';
import {
  computeRatePerMin,
  computeStreakMin,
  withWarmUp,
} from './change-detector.js';
import type {
  EnvironmentSensor,
  ImFacet,
  InboundFacet,
  InnerBrainsFacet,
  LlmUsageFacet,
  ProcessFacet,
  TimeFacet,
} from './environment-types.js';

/** P0 — 内脑数量（含 asyncWaiting）+ AWAITING 连续过载派生 */
export const innerBrainsSensor: EnvironmentSensor<InnerBrainsFacet> = {
  id: 'innerBrains',
  label: '内脑负载',
  description: '内脑实例 RUNNING/AWAITING/BLOCKED 计数与 async 等待数；awaiting_streakMin 表示 AWAITING 持续过载时长。',
  cadence: 'every_tick',
  read(ctx) {
    let running = 0;
    let awaiting = 0;
    let blocked = 0;
    let asyncWaiting = 0;
    for (const t of ctx.registry.list()) {
      if (t.status === 'RUNNING') running += 1;
      else if (t.status === 'AWAITING') awaiting += 1;
      else if (t.status === 'BLOCKED') blocked += 1;
      if (t.status === 'RUNNING' || t.status === 'AWAITING' || t.status === 'BLOCKED') {
        try {
          if (buildBrainAsyncSnapshot(t.workDir).is_async_waiting) asyncWaiting += 1;
        } catch {
          /* ignore */
        }
      }
    }
    return { running, awaiting, blocked, asyncWaiting };
  },
  derive(history) {
    const out: Record<string, number> = {};
    const streak = withWarmUp(history.samples, 2, () =>
      computeStreakMin(history.samples, (d) => d.awaiting >= 1),
    );
    if (streak != null) out['awaiting_streakMin'] = round2(streak);
    return out;
  },
  detectEvents(prev, next, _history, nowIso) {
    if (prev && prev.awaiting < 1 && next.awaiting >= 1) {
      return [{
        at: nowIso,
        sensorId: 'innerBrains',
        kind: 'threshold_crossed',
        field: 'awaiting',
        before: prev.awaiting,
        after: next.awaiting,
        note: `内脑出现 AWAITING（${next.awaiting} 个等外部）`,
      }];
    }
    return [];
  },
};

/** P0 — LLM 用量（包装 llmUsageTracker）+ token 速率派生 */
export const llmUsageSensor: EnvironmentSensor<LlmUsageFacet> = {
  id: 'llmUsage',
  label: 'LLM 用量',
  description: '在途 LLM 调用数与近 1h token/调用量；tokensRatePerMin 表示 token 消耗速率（趋势）。',
  cadence: 'every_tick',
  read(ctx) {
    return ctx.getLlmUsageSnapshot();
  },
  derive(history) {
    const out: Record<string, number> = {};
    const rate = withWarmUp(history.samples, 2, () =>
      computeRatePerMin(history.samples, (d) => d.tokensLast1h.total),
    );
    if (rate != null) out['tokensRatePerMin'] = round2(rate);
    return out;
  },
};

/** P0 — 入站队列深度 */
export const inboundSensor: EnvironmentSensor<InboundFacet> = {
  id: 'inbound',
  label: '入站负载',
  description: 'threadOrchestrator 排队总深度与 outerLoop 占用线程数；高表示外脑正忙于回消息。',
  cadence: 'every_tick',
  read(ctx) {
    const orch = ctx.getOrchestratorStats();
    return {
      orchestratorQueuedTotal: orch.queuedTotal,
      outerLoopActiveThreads: orch.activeThreads,
    };
  },
};

/** P0 — IM 主动发言频控状态 */
export const imSensor: EnvironmentSensor<ImFacet> = {
  id: 'im',
  label: 'IM 频控',
  description: '最近一次主动发言时间与 5 分钟内主动发言计数；用于闲聊频控与「最近是否话太多」。',
  cadence: 'every_tick',
  read(ctx) {
    const st = ctx.getParticipationState(ctx.defaultThreadId.trim() || 'global');
    return {
      lastProactiveSpeakAt: st.lastProactiveAt > 0 ? new Date(st.lastProactiveAt).toISOString() : null,
      proactiveCount5min: st.proactiveCount5min,
    };
  },
};

/** P0 — 进程内存 */
export const processSensor: EnvironmentSensor<ProcessFacet> = {
  id: 'process',
  label: '进程内存',
  description: '外脑进程 heap / rss（MB）；持续上行可能是泄漏。',
  cadence: 'every_tick',
  read(ctx) {
    const mem = ctx.getProcessMemory();
    return {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
    };
  },
};

/** P1 — 时段语义（深夜 / 工作日 vs 休息日），由 ctx.now 决定 deterministic */
export const timeSensor: EnvironmentSensor<TimeFacet> = {
  id: 'time',
  label: '时段',
  description: '墙钟时段语义：hour、是否深夜 isQuietHours（默认 0-7 点）、工作日/休息日；战略层据此调节主动性。',
  cadence: 'every_tick',
  read(ctx) {
    const d = new Date(ctx.now);
    const hour = d.getUTCHours();
    const dayOfWeek = d.getUTCDay();
    return {
      iso: d.toISOString(),
      hour,
      dayOfWeek,
      isQuietHours: hour < 7,
      dayOfWeekKind: dayOfWeek === 0 || dayOfWeek === 6 ? 'weekend' : 'weekday',
    };
  },
};

/** P0 内置 sensor（行为等价 resourceProbe）+ P1 timeSensor */
export const BUILTIN_SENSORS: EnvironmentSensor[] = [
  innerBrainsSensor as EnvironmentSensor,
  llmUsageSensor as EnvironmentSensor,
  inboundSensor as EnvironmentSensor,
  imSensor as EnvironmentSensor,
  processSensor as EnvironmentSensor,
  timeSensor as EnvironmentSensor,
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
