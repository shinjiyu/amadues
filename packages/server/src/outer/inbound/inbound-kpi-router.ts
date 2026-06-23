/**
 * IM 入站软闸门分流 — ADL IM-INBOUND-INTENT-ROUTING.md §4/§5
 *
 * 软闸门：仅 ad_hoc / kpi_update / kpi_create 这类**高置信显式**意图 shortCircuit（handled=true）；
 * chat_only / task_followup → handled=false，**继续进对话环**（消除误判不可恢复）。
 */
import type { KpiRegistry } from '../kpi-registry.js';
import type { InnerBrainRegistry, TaskStatus } from '../inner-brain-registry.js';
import type { OuterToolContext } from '../outer-tools.js';
import { advanceKpi, type KpiAdvancerDeps } from '../kpi/kpi-advancer.js';
import { dispatchAdHocBurst } from '../ad-hoc-burst-allocator.js';
import {
  classifyImInboundIntent,
  type ExistingWorkRef,
  type ImClassifyContext,
  type ImInboundIntent,
} from './im-intent-classifier.js';

export interface InboundKpiRouterDeps {
  dataRoot: string;
  kpiRegistry: KpiRegistry;
  toolCtx: OuterToolContext;
  workspaceId: string;
  defaultThreadId: string;
  originUser: string;
}

export interface InboundKpiRouterResult {
  /** 是否短路对话环（仅高置信显式意图为 true） */
  handled: boolean;
  intent: ImInboundIntent;
  replyText?: string;
}

/** 在跑/等待中的既有任务状态 */
const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(['RUNNING', 'BLOCKED', 'AWAITING']);

/**
 * 组装只读上下文（按 origin 过滤）：
 *  - activeKpis：本 origin 创建的 active KPI（去重 + kpi_update 目标）
 *  - followupRef：本 thread 在跑/等待的既有任务（追问转 task_followup）
 */
export function assembleClassifyContext(deps: InboundKpiRouterDeps): ImClassifyContext {
  const activeKpis = deps.kpiRegistry
    .list({ status: 'active' })
    .filter((k) => k.createdBy === deps.originUser)
    .map((k) => ({ kpiId: k.kpiId, description: k.description }));

  let followupRef: ExistingWorkRef | undefined;
  const innerRegistry: InnerBrainRegistry | undefined = deps.toolCtx.innerBrainRegistry;
  if (innerRegistry) {
    const liveInThread = innerRegistry
      .list()
      .filter(
        (t) =>
          LIVE_STATUSES.has(t.status) &&
          (t.originThread === deps.defaultThreadId || t.originUser === deps.originUser),
      )
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    const burst = liveInThread[0];
    if (burst) {
      followupRef = { kind: 'burst', id: burst.instanceId, matchReason: 'in_flight' };
    }
  }
  // 无在跑 burst 时，回退到最近的 active KPI 作为追问目标
  if (!followupRef && activeKpis.length > 0) {
    followupRef = { kind: 'kpi', id: activeKpis[0]!.kpiId, matchReason: 'recent_thread' };
  }

  return { activeKpis, followupRef };
}

export async function routeInboundKpiOrAdHoc(
  deps: InboundKpiRouterDeps,
  userMessage: string,
): Promise<InboundKpiRouterResult> {
  const ctx = assembleClassifyContext(deps);
  const intent = classifyImInboundIntent(userMessage, ctx);

  // 软闸门：默认/追问不短路，交对话环
  if (intent.kind === 'chat_only' || intent.kind === 'task_followup') {
    return { handled: false, intent };
  }

  if (intent.kind === 'ad_hoc_task') {
    const res = await dispatchAdHocBurst(deps.dataRoot, deps.toolCtx, {
      goal: intent.goal,
      originUser: deps.originUser,
      originThread: deps.defaultThreadId,
      workspaceId: deps.workspaceId,
    });
    return {
      handled: true,
      intent,
      replyText: res.ok
        ? `已派发一次性任务（${res.instanceId ?? '内脑'}）。`
        : `一次性任务派发失败：${res.output.slice(0, 160)}`,
    };
  }

  const advancerDeps: KpiAdvancerDeps = {
    kpiRegistry: deps.kpiRegistry,
    innerBrainRegistry: deps.toolCtx.innerBrainRegistry!,
    toolCtx: deps.toolCtx,
    workspaceId: deps.workspaceId,
    defaultThreadId: deps.defaultThreadId,
  };

  if (intent.kind === 'kpi_update') {
    const existing = deps.kpiRegistry.get(intent.kpiId);
    if (existing) {
      const mergedNotes = [existing.notes, intent.note].filter(Boolean).join('\n');
      deps.kpiRegistry.update(intent.kpiId, { notes: mergedNotes });
    }
    const adv = await advanceKpi(advancerDeps, intent.kpiId);
    return {
      handled: true,
      intent,
      replyText: existing
        ? `已更新既有 KPI（${intent.kpiId}）：${adv.ok ? adv.reason : '推进待心跳'}`
        : `未找到 KPI ${intent.kpiId}，已忽略更新。`,
    };
  }

  // intent.kind === 'kpi_create'（仅 ongoing）
  const kpi = deps.kpiRegistry.create({
    description: intent.description,
    createdBy: deps.originUser,
    kind: 'ongoing',
  });
  const adv = await advanceKpi(advancerDeps, kpi.kpiId);
  return {
    handled: true,
    intent,
    replyText: adv.ok
      ? `已登记 KPI（${kpi.kpiId}）并推进：${adv.reason}${adv.instanceId ? ` → ${adv.instanceId}` : ''}`
      : `已登记 KPI（${kpi.kpiId}），推进待心跳：${adv.reason}`,
  };
}
