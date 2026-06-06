/**
 * 战略规划层 — dispatcher 退化形态（ADL STRATEGY-PLANNING-LAYER.md §8/§10）。
 *
 * dispatcher 不再自由选 KPI；按 strategy.focusOrder 与 registry active **取交集**（保 strategy 顺序）挑下一个：
 *   - 跳过 registry 显式 paused/archived（不在 activeKpiIds）
 *   - 跳过 cooldown 中的 KPI
 *   - 资源闸门（canSpawn=false）→ 不派 KPI
 * strategy 缺失 → none（首启动由 planner 触发）。
 * 纯函数（随机闲聊骰由 caller 掷）。
 */
import type { StrategyArtifact } from './strategy-types.js';

export interface StrategyDispatchContext {
  activeKpiIds: Set<string>;
  canSpawn: boolean;
  onCooldown: (kpiId: string) => boolean;
}

export type StrategyDispatchSelection =
  | { kind: 'kpi'; kpiId: string }
  | { kind: 'none_active'; reason: string };

export function selectStrategyDispatch(
  strategy: StrategyArtifact | null,
  ctx: StrategyDispatchContext,
): StrategyDispatchSelection {
  if (!strategy) return { kind: 'none_active', reason: 'no_strategy' };

  const intersection = strategy.focusOrder.filter((id) => ctx.activeKpiIds.has(id));
  if (intersection.length === 0) {
    return { kind: 'none_active', reason: 'focus_order_empty_after_intersect' };
  }

  if (!ctx.canSpawn) return { kind: 'none_active', reason: 'resource_gate' };

  for (const kpiId of intersection) {
    if (ctx.onCooldown(kpiId)) continue;
    return { kind: 'kpi', kpiId };
  }
  return { kind: 'none_active', reason: 'all_on_cooldown' };
}
