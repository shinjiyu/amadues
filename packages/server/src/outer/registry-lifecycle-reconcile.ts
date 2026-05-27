/**
 * Registry ↔ workDir 对账（AWAITING/BLOCKED 假挂起 → DONE）。
 *
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §4–§5.1
 * @see doc/todo/inner-brain-awaiting-lifecycle.md
 */
import type { InnerBrainRegistry, TaskStatus } from './inner-brain-registry.js';

export interface RegistryReconcileChange {
  instanceId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}

/**
 * 扫描 registry 中 AWAITING/BLOCKED，按 `buildBrainAsyncSnapshot` 收口终态。
 * 实现待 P0（当前返回空数组，单测将失败直至落地）。
 */
export function registryLifecycleReconcile(
  _registry: InnerBrainRegistry,
): RegistryReconcileChange[] {
  return [];
}
