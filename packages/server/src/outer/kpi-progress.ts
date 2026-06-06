/**
 * KPI 进展推断 — 纯函数，供 burst onExit、view_kpi、场景 harness 共用。
 */
import type { ReflexionSummary, KpiRecord, KpiKind } from './kpi-registry.js';
import type { InnerBrainRegistry, TaskRecord, TaskStatus } from './inner-brain-registry.js';
import { buildBrainAsyncSnapshot } from './brain-async-snapshot.js';
import { LIVE_KPI_BURST_STATUSES } from './kpi-dispatch-guard.js';

export type KpiSuggestedAction =
  | 'achieved'       // 应 markAchieved（或已自动达成）
  | 'awaiting_human' // ask_user pending，正常等待人类；勿重复 set_goal
  | 'follow_up'      // 真 stuck / 无 ask_user 的 AWAITING，外脑应介入
  | 'continue'       // 仍在推进，可等 timer / 勿重复 set_goal
  | 'stuck_reflexion'// idle streak 高，已/将派反思 burst
  | 'abandon_candidate';

export interface KpiBurstLink {
  instanceId: string;
  registryStatus: string;
  isPostComplete: boolean;
  isAsyncWaiting: boolean;
  hasAskUserPending: boolean;
  deliverableCount: number;
  lastReflexionVerdict: string | null;
}

/** burst 正常结束且目标已交付 → 可自动标 achieved */
export function shouldAutoAchieveKpi(input: {
  reflexion: ReflexionSummary | null;
  deliverableCount: number;
  isAwaiting: boolean;
  exitedWithError: boolean;
  isPostComplete: boolean;
  /** KPI 类型；'ongoing' 永不 auto-achieve（KPI-COMPLETION-JUDGE.md §3b） */
  kind?: KpiKind;
}): boolean {
  // 常驻 / 周期 / 监督类 KPI：交付物只是节拍产出，禁止自动结案
  if (input.kind === 'ongoing') return false;
  if (input.exitedWithError || input.isAwaiting) return false;
  if (!input.isPostComplete) return false;
  if (input.deliverableCount < 1) return false;
  const v = input.reflexion?.verdict;
  if (v === 'success') return true;
  if (v === 'partial') return true;
  if (!input.reflexion) return true;
  return false;
}

function isLiveRegistryStatus(status: string): boolean {
  return LIVE_KPI_BURST_STATUSES.has(status as TaskStatus);
}

export function buildKpiBurstLinks(
  kpi: KpiRecord,
  innerRegistry: InnerBrainRegistry | undefined,
): KpiBurstLink[] {
  if (!innerRegistry) {
    return kpi.bursts.map((id) => ({
      instanceId: id,
      registryStatus: 'unknown',
      isPostComplete: false,
      isAsyncWaiting: false,
      hasAskUserPending: false,
      deliverableCount: 0,
      lastReflexionVerdict: null,
    }));
  }
  return kpi.bursts.flatMap((id): KpiBurstLink[] => {
    const t = innerRegistry.get(id);
    if (t && t.kpiId != null && t.kpiId !== kpi.kpiId) {
      return [];
    }
    if (!t) {
      return [{
        instanceId: id,
        registryStatus: 'missing',
        isPostComplete: false,
        isAsyncWaiting: false,
        hasAskUserPending: false,
        deliverableCount: 0,
        lastReflexionVerdict: null,
      }];
    }
    const snap = buildBrainAsyncSnapshot(t.workDir);
    const trail = kpi.reflexionTrail.filter((r) => r.burstInstanceId === id);
    const lastVerdict = trail[0]?.verdict ?? null;
    const hasAskUserPending = snap.active_pendings.some((p) => p.kind === 'ask_user');
    return [{
      instanceId: id,
      registryStatus: t.status,
      isPostComplete: snap.is_post_complete,
      isAsyncWaiting: snap.is_async_waiting,
      hasAskUserPending,
      deliverableCount: t.deliverableCount ?? 0,
      lastReflexionVerdict: lastVerdict,
    }];
  });
}

export function suggestKpiAction(
  kpi: KpiRecord,
  links: KpiBurstLink[],
  stuckThreshold = 3,
): { action: KpiSuggestedAction; reason: string } {
  if (kpi.status === 'achieved' || kpi.status === 'abandoned') {
    return { action: 'achieved', reason: `终态 ${kpi.status}` };
  }
  if (kpi.status === 'paused') {
    return { action: 'continue', reason: '已暂停' };
  }

  const latest = links[links.length - 1];
  const liveLinks = links.filter((l) => isLiveRegistryStatus(l.registryStatus));
  const anyAwaiting = liveLinks.some((l) => l.isAsyncWaiting && !l.isPostComplete);
  const anyBlocked = liveLinks.some(
    (l) => l.registryStatus === 'BLOCKED' || l.registryStatus === 'AWAITING',
  );
  const latestDone = latest?.registryStatus === 'DONE' && latest.isPostComplete;

  if (latestDone && latest.deliverableCount > 0) {
    const v = latest.lastReflexionVerdict;
    if (v === 'success' || v === 'partial' || v === null) {
      // ongoing 常驻 KPI：交付完成不结案，继续巡检（KPI-COMPLETION-JUDGE.md §3b）
      if (kpi.kind === 'ongoing') {
        return { action: 'continue', reason: 'ongoing 常驻：交付后继续巡检' };
      }
      return { action: 'achieved', reason: '最近 burst 已 DONE 且里程碑完成并有产出' };
    }
  }

  const anyAwaitingHuman = liveLinks.some(
    (l) => l.isAsyncWaiting && l.hasAskUserPending && !l.isPostComplete,
  );
  if (anyAwaitingHuman) {
    return { action: 'awaiting_human', reason: '有 burst 在等人类回复 ask_user，勿重复 set_goal' };
  }

  if (anyAwaiting || (anyBlocked && !latestDone)) {
    return { action: 'follow_up', reason: '有 burst 阻塞或等待外部（非 ask_user），需外脑介入' };
  }

  if (kpi.consecutiveIdleBursts >= stuckThreshold) {
    return { action: 'stuck_reflexion', reason: `连续 ${kpi.consecutiveIdleBursts} 次 idle 无产出` };
  }

  const running = links.some((l) => l.registryStatus === 'RUNNING');
  if (running) {
    return { action: 'continue', reason: '仍有 burst 在跑' };
  }

  return { action: 'continue', reason: '活跃推进中' };
}

export function formatKpiDigest(
  kpi: KpiRecord,
  innerRegistry: InnerBrainRegistry | undefined,
  stuckThreshold = 3,
): string {
  const links = buildKpiBurstLinks(kpi, innerRegistry);
  const { action, reason } = suggestKpiAction(kpi, links, stuckThreshold);
  const lines: string[] = [
    `KPI ${kpi.kpiId} [${kpi.status}/${kpi.kind}]`,
    `描述：${kpi.description}`,
    `建议动作：${action}（${reason}）`,
    `连续 idle：${kpi.consecutiveIdleBursts}`,
    `momentum：${kpi.momentum}`,
    `bursts：${kpi.bursts.length}`,
  ];
  if (links.length > 0) {
    lines.push('', '关联 burst：');
    for (const l of links.slice(-6)) {
      lines.push(
        `- ${l.instanceId} status=${l.registryStatus}` +
          ` post_complete=${l.isPostComplete}` +
          ` async_wait=${l.isAsyncWaiting}` +
          ` deliverables=${l.deliverableCount}` +
          (l.lastReflexionVerdict ? ` verdict=${l.lastReflexionVerdict}` : ''),
      );
    }
  }
  if (action === 'achieved' && kpi.status === 'active') {
    lines.push('', '⚠️ 系统判定已达成但 registry 仍为 active；应调用 achieve_kpi 或等待自动达成。');
  }
  return lines.join('\n');
}
