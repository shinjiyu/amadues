/**
 * KPI 管理器 — live reaper 依赖注入（kill / ABORTED / action-log）
 * ADL: doc/structurizr/KPI-MANAGER-LAYER.md §3.1 R5
 */
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import { appendAutonomyActionLog } from '../autonomy-action-log.js';
import type { ReaperDeps } from './stale-burst-reaper.js';

export function buildKpiReaperDeps(
  registry: InnerBrainRegistry,
  dataRoot: string,
  now: () => number = Date.now,
): ReaperDeps {
  return {
    getTask: (id) => registry.get(id),
    killProcess: (pid) => {
      if (typeof pid === 'number' && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* 进程可能已退出 */
        }
      }
    },
    abort: (id, patch) => {
      registry.update(id, {
        status: 'ABORTED',
        abortReason: patch.abortReason,
        abortedBy: patch.abortedBy,
        abortedAt: patch.abortedAt,
      });
    },
    appendActionLog: (e) => {
      appendAutonomyActionLog(dataRoot, {
        at: e.at,
        dispatched: false,
        reason: `cull_burst:${e.reason}`,
        detail: `${e.reaper}:${e.burstId}`,
      });
    },
    now,
  };
}
