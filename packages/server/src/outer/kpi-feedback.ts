/**
 * 多巴胺反馈调节（Dopamine Loop）— 纯函数。
 *
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §16
 *
 * burst 退出后把「这一轮干得怎样」映射为一个标量增量（Δmomentum）：
 *   - 有效推进（success + 产出）→ 正反馈，KPI momentum 升，dispatcher 持续优先派活
 *   - idle / failed → 负反馈，momentum 降，让位给更有产出的 KPI
 *
 * 这是战略层 LLM 叙事调度（focusOrder / recentLessons）落地前的 **P0-interim 量化回路**，
 * 构建在现有 autonomyTaskDispatcher + kpiBurstHooks 上，不引入新调度器。
 *
 * 守门：deterministic（无 random / LLM），便于单测断言；clamp 由 KpiRegistry.adjustMomentum 负责。
 */
import type { KpiRecord } from './kpi-registry.js';

/** burst 退出时可观测的反馈信号（与 kpiBurstHooks.BurstExitOutcome 同源） */
export interface BurstFeedbackSignal {
  /** outcome 等价 verdict；无产出且失败为 failed */
  verdict: 'success' | 'partial' | 'failed' | null;
  /** deliverables.json 条目数 */
  deliverableCount: number;
  /** 是否处于 AWAITING（等外部）：不奖不罚 */
  isAwaiting: boolean;
  /** 进程级失败 */
  exitedWithError: boolean;
}

/**
 * 信号 → momentum 增量（见 ADL §16.2 表）。
 * 纯函数：同输入同输出，无副作用。
 */
export function computeMomentumDelta(signal: BurstFeedbackSignal): number {
  // 等外部回复期间 KPI 进展不变：不奖不罚（与 idle streak 口径一致）
  if (signal.isAwaiting) return 0;

  // 进程级失败：强负反馈，先于 verdict 判定
  if (signal.exitedWithError) return -2;

  const hasDeliverable = signal.deliverableCount > 0;

  switch (signal.verdict) {
    case 'success':
      return hasDeliverable ? 2 : 1;
    case 'partial':
      return hasDeliverable ? 1 : 0;
    case 'failed':
      return -2;
    case null:
    default:
      // 未确认成功：有产出弱奖赏，空转弱惩罚
      return hasDeliverable ? 1 : -1;
  }
}

/**
 * 按 momentum 选一个 active KPI：momentum 降序，平手按 createdAt 新者优先。
 *
 * dispatcher 用它取代固定的 `list({active})[0]`，实现「正反馈延续 / 负反馈退避」的派活顺序。
 * 入参应为已过滤的 active KPI 列表；空列表返回 undefined。
 */
export function selectKpiByMomentum(activeKpis: KpiRecord[]): KpiRecord | undefined {
  if (activeKpis.length === 0) return undefined;
  return [...activeKpis].sort((a, b) => {
    if (b.momentum !== a.momentum) return b.momentum - a.momentum;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  })[0];
}
