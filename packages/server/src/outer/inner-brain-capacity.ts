/**
 * 内脑运行槽位：仅 RUNNING 占容量；AWAITING/BLOCKED 不计入自动派发上限。
 */
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { loadAutonomyPolicy } from './autonomy-policy-store.js';

/** 占用「运行槽位」的实例数（仅 RUNNING） */
export function countRunningInnerBrains(registry: InnerBrainRegistry): number {
  return registry.list().filter((t) => t.status === 'RUNNING').length;
}

export function resolveMaxRunningInnerBrains(dataRoot: string): number {
  return Math.max(1, loadAutonomyPolicy(dataRoot).hardGates.maxRunningInnerBrains);
}

export interface InnerBrainCapacityCheck {
  ok: boolean;
  running: number;
  maxRunning: number;
  reason?: string;
}

/** 自动派发 / 心跳 set_goal 是否还能再占一个 RUNNING 槽位 */
export function checkRunningInnerBrainCapacity(
  registry: InnerBrainRegistry,
  dataRoot: string,
): InnerBrainCapacityCheck {
  const running = countRunningInnerBrains(registry);
  const maxRunning = resolveMaxRunningInnerBrains(dataRoot);
  if (running >= maxRunning) {
    return {
      ok: false,
      running,
      maxRunning,
      reason:
        `运行槽位已满：当前 RUNNING=${running} ≥ 上限 ${maxRunning}（AWAITING 不计入）`,
    };
  }
  return { ok: true, running, maxRunning };
}
