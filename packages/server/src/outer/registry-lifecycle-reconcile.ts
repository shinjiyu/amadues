/**
 * Registry ↔ workDir 对账（AWAITING/BLOCKED 假挂起 → DONE）。
 *
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §4–§5.1
 */
import { buildBrainAsyncSnapshot } from './brain-async-snapshot.js';
import type { InnerBrainRegistry, TaskStatus } from './inner-brain-registry.js';

export interface RegistryReconcileChange {
  instanceId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}

/**
 * 扫描 registry 中 AWAITING/BLOCKED，按 workDir 快照收口终态。
 */
export function registryLifecycleReconcile(registry: InnerBrainRegistry): RegistryReconcileChange[] {
  const changes: RegistryReconcileChange[] = [];
  const now = new Date().toISOString();

  for (const record of registry.list()) {
    if (record.status !== 'AWAITING' && record.status !== 'BLOCKED') continue;

    let snap;
    try {
      snap = buildBrainAsyncSnapshot(record.workDir);
    } catch {
      continue;
    }

    if (!snap.is_post_complete && snap.is_async_waiting) continue;

    registry.update(record.instanceId, { status: 'DONE', finishedAt: now });
    changes.push({
      instanceId: record.instanceId,
      from: record.status,
      to: 'DONE',
      reason: snap.is_post_complete ? 'is_post_complete' : 'not_async_waiting',
    });
  }

  return changes;
}
