/**
 * IM 入站 KPI / ad-hoc 分流（在对话环之前）— KPI-ADVANCEMENT.md §2
 */
import type { KpiRegistry } from '../kpi-registry.js';
import type { OuterToolContext } from '../outer-tools.js';
import { advanceKpi, type KpiAdvancerDeps } from '../kpi/kpi-advancer.js';
import { dispatchAdHocBurst } from '../ad-hoc-burst-allocator.js';
import { classifyImInboundIntent, type ImInboundIntent } from './im-intent-classifier.js';

export interface InboundKpiRouterDeps {
  dataRoot: string;
  kpiRegistry: KpiRegistry;
  toolCtx: OuterToolContext;
  workspaceId: string;
  defaultThreadId: string;
  originUser: string;
}

export interface InboundKpiRouterResult {
  handled: boolean;
  intent: ImInboundIntent;
  replyText?: string;
}

export async function routeInboundKpiOrAdHoc(
  deps: InboundKpiRouterDeps,
  userMessage: string,
): Promise<InboundKpiRouterResult> {
  const intent = classifyImInboundIntent(userMessage);

  if (intent.kind === 'chat_only') {
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

  if (intent.kind === 'kpi_create' || intent.kind === 'kpi_update') {
    const ongoing = intent.kind === 'kpi_create' ? intent.ongoing : true;
    const kpi = deps.kpiRegistry.create({
      description: intent.description,
      createdBy: deps.originUser,
      notes: intent.notes,
      kind: ongoing ? 'ongoing' : 'delivery',
      asParent: ongoing,
    });

    const advancerDeps: KpiAdvancerDeps = {
      kpiRegistry: deps.kpiRegistry,
      innerBrainRegistry: deps.toolCtx.innerBrainRegistry!,
      toolCtx: deps.toolCtx,
      workspaceId: deps.workspaceId,
      defaultThreadId: deps.defaultThreadId,
    };

    const adv = await advanceKpi(advancerDeps, kpi.kpiId);
    return {
      handled: true,
      intent,
      replyText: adv.ok
        ? `已登记 KPI（${kpi.kpiId}）并推进：${adv.reason}${adv.instanceId ? ` → ${adv.instanceId}` : ''}`
        : `已登记 KPI（${kpi.kpiId}），推进待心跳：${adv.reason}`,
    };
  }

  return { handled: false, intent };
}
