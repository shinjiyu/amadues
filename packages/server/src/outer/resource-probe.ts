import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { buildBrainAsyncSnapshot } from './brain-async-snapshot.js';
import { getGroupParticipationState } from './participation-state.js';
import { getLlmUsageSnapshot } from './llm-usage-tracker.js';
import type { ResourceSnapshot } from './autonomy-types.js';

export interface ResourceProbeDeps {
  agentId: string;
  registry: InnerBrainRegistry;
  /** 可选：thread orchestrator 队列深度 */
  getOrchestratorStats?: () => { queuedTotal: number; activeThreads: number };
  /** 用于 IM 频控快照的默认 thread（心跳 IM 线程） */
  defaultThreadId?: string;
}

export function collectResourceSnapshot(deps: ResourceProbeDeps): ResourceSnapshot {
  const tasks = deps.registry.list();
  let running = 0;
  let awaiting = 0;
  let blocked = 0;
  let asyncWaiting = 0;

  for (const t of tasks) {
    if (t.status === 'RUNNING') running += 1;
    else if (t.status === 'AWAITING') awaiting += 1;
    else if (t.status === 'BLOCKED') blocked += 1;

    if (t.status === 'RUNNING' || t.status === 'AWAITING' || t.status === 'BLOCKED') {
      try {
        const snap = buildBrainAsyncSnapshot(t.workDir);
        if (snap.is_async_waiting) asyncWaiting += 1;
      } catch {
        /* ignore */
      }
    }
  }

  const llm = getLlmUsageSnapshot();
  const orch = deps.getOrchestratorStats?.() ?? { queuedTotal: 0, activeThreads: 0 };
  const threadId = deps.defaultThreadId?.trim() || 'global';
  const imState = getGroupParticipationState(threadId);
  const mem = process.memoryUsage();

  return {
    capturedAt: new Date().toISOString(),
    agentId: deps.agentId,
    innerBrains: { running, awaiting, blocked, asyncWaiting },
    llm,
    inbound: {
      orchestratorQueuedTotal: orch.queuedTotal,
      outerLoopActiveThreads: orch.activeThreads,
    },
    im: {
      lastProactiveSpeakAt: imState.lastProactiveAt > 0 ? new Date(imState.lastProactiveAt).toISOString() : null,
      proactiveCount5min: imState.proactiveCount5min,
    },
    process: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
    },
  };
}

/** 是否存在任一内脑实例处于 async waiting */
export function anyInnerBrainAsyncWaiting(registry: InnerBrainRegistry): boolean {
  return collectResourceSnapshot({ agentId: '-', registry }).innerBrains.asyncWaiting > 0;
}
