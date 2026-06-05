/**
 * KPI 完成判定 — 心跳 tick 程序化 sweep + 摘要注入。
 *
 * ADL: doc/structurizr/KPI-COMPLETION-JUDGE.md
 */
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { KpiRegistry } from './kpi-registry.js';
import { hasLiveWorkForKpi } from './kpi-dispatch-guard.js';
import { buildKpiBurstLinks, suggestKpiAction } from './kpi-progress.js';

export interface KpiCompletionSweepResult {
  /** 本 tick 自动 markAchieved 的 kpiId */
  marked: string[];
  /** active 且 suggest=achieved 但未自动标记（在途 burst 等） */
  pending: Array<{ kpiId: string; reason: string }>;
}

/**
 * 扫描 active KPI：满足完成条件且无在途 burst → 自动 markAchieved。
 * 规则与 kpiBurstHooks onExit autoAchieved / suggestKpiAction 一致。
 */
export function sweepKpiCompletions(
  kpiRegistry: KpiRegistry,
  innerRegistry: InnerBrainRegistry,
): KpiCompletionSweepResult {
  const marked: string[] = [];
  const pending: Array<{ kpiId: string; reason: string }> = [];

  for (const kpi of kpiRegistry.list({ status: 'active' })) {
    if (kpi.bursts.length === 0) continue;
    const links = buildKpiBurstLinks(kpi, innerRegistry);
    const { action, reason } = suggestKpiAction(kpi, links);
    if (action !== 'achieved') continue;

    if (hasLiveWorkForKpi(innerRegistry, kpi.kpiId)) {
      pending.push({ kpiId: kpi.kpiId, reason: `在途 burst 未结束：${reason}` });
      continue;
    }

    const evidence = `心跳 sweep：${reason}`;
    kpiRegistry.markAchieved(kpi.kpiId, evidence);
    marked.push(kpi.kpiId);
  }

  return { marked, pending };
}

/** 注入心跳 user 段的 active KPI 完成态摘要 */
export function formatKpiCompletionBlock(
  kpiRegistry: KpiRegistry,
  innerRegistry: InnerBrainRegistry | undefined,
): string {
  if (!innerRegistry) return '';

  const active = kpiRegistry.list({ status: 'active' });
  const achieved = kpiRegistry.list({ status: 'achieved' });
  if (active.length === 0 && achieved.length === 0) return '';

  const lines: string[] = ['## KPI 完成态（心跳须核对）'];

  for (const kpi of active) {
    const links = buildKpiBurstLinks(kpi, innerRegistry);
    const { action, reason } = suggestKpiAction(kpi, links);
    lines.push(`- ${kpi.kpiId} [active] 建议=${action}（${reason}）`);
    if (action === 'achieved') {
      lines.push('  → 若 sweep 未自动结案，请 view_kpi 核对后 achieve_kpi');
    }
  }

  for (const kpi of achieved.slice(-5)) {
    lines.push(
      `- ${kpi.kpiId} [achieved] ${kpi.finalizedReason?.slice(0, 80) ?? ''}`,
    );
  }

  lines.push(
    '',
    '完成判定：burst post_complete + 有 deliverable + reflexion 支持 → 程序化 achieved；',
    '开放式/监督类 KPI 须战略 WHY 判断后再 achieve_kpi（附 evidence）。',
  );

  return lines.join('\n');
}
