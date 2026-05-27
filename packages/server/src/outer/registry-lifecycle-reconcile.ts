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

export interface RegistryReconcileMetrics {
  runs: number;
  lastRunAt: string | null;
  lastChangeCount: number;
  totalChanges: number;
}

const metrics: RegistryReconcileMetrics = {
  runs: 0,
  lastRunAt: null,
  lastChangeCount: 0,
  totalChanges: 0,
};

export function getRegistryReconcileMetrics(): RegistryReconcileMetrics {
  return { ...metrics };
}

/** 测试 / 进程重启时清零计数 */
export function resetRegistryReconcileMetrics(): void {
  metrics.runs = 0;
  metrics.lastRunAt = null;
  metrics.lastChangeCount = 0;
  metrics.totalChanges = 0;
}

function recordMetrics(changeCount: number): void {
  metrics.runs += 1;
  metrics.lastRunAt = new Date().toISOString();
  metrics.lastChangeCount = changeCount;
  metrics.totalChanges += changeCount;
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

  recordMetrics(changes.length);
  return changes;
}

export interface RegistryReconcileIntervalOptions {
  intervalMs?: number;
  onRun?: (changes: RegistryReconcileChange[]) => void;
}

/**
 * 周期 reconcile（默认 60s；`intervalMs <= 0` 时不启动）。
 * 返回 stop 函数。
 */
export function startRegistryLifecycleReconcileInterval(
  registry: InnerBrainRegistry,
  options: RegistryReconcileIntervalOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  if (intervalMs <= 0) return () => {};

  const timer = setInterval(() => {
    const changes = registryLifecycleReconcile(registry);
    options.onRun?.(changes);
    if (changes.length > 0) {
      console.log(
        `[utlra][registry-reconcile] periodic: ${changes.length} update(s) ` +
          changes.map((c) => `${c.instanceId}:${c.reason}`).join(', '),
      );
    }
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
