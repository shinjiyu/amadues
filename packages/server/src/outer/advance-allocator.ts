/**
 * 推进调配 — 窄 goal 文案 + 简单规则（ADL KPI-ADVANCE-WORK-PACKAGE.md §3）
 */
import type { EnsurePeriodicCommitmentInput } from '../scheduler/employee-calendar.js';
import type { AdvancePerception } from './advance-perception.js';
import { shouldSkipSelfWorkForKpi } from './advance-perception.js';
import type { SelfWorkKpi, SelfWorkProposal } from './self-work-policy.js';

const MAX_NARROW_DESC = 180;

function shortDesc(description: string): string {
  const t = description.trim().replace(/\s+/g, ' ');
  return t.length <= MAX_NARROW_DESC ? t : `${t.slice(0, MAX_NARROW_DESC)}…`;
}

/**
 * 构造有限推进 action（禁止 Duty/charter 全文）。
 * 优先 repair（规则 8），否则 bootstrap；基线已完成且无需 repair → null（等日历）。
 */
export function buildNarrowDraftProposal(
  kpi: SelfWorkKpi,
  perception: AdvancePerception | undefined,
  strategyId: string,
): SelfWorkProposal | null {
  if (perception && shouldSkipSelfWorkForKpi(perception, kpi.kpiId)) {
    return null;
  }

  const desc = shortDesc(kpi.description);

  if (perception?.kpiIdsNeedingRepair.includes(kpi.kpiId)) {
    const stall = perception.stallByKpi[kpi.kpiId]?.[0];
    const signalHint = stall?.signals?.length ? stall.signals.join(',') : 'stall';
    const summaryHint = stall?.summary?.slice(0, 160) ?? '近期空转/缺交付';
    return {
      kpiId: kpi.kpiId,
      action:
        `【本轮工作包·repair】KPI「${desc}」上一轮出现 stall（${signalHint}）：${summaryHint}。` +
        `只修复缺口：核对产物、补齐缺失交付或换一条可验证短路径；禁止重放整份 Duty/首次全量。`,
      expectedOutcome: `一份简短修复纪要 + 至少 1 个可核对产物（或明确「无需新产物」的证据）`,
      reason: '感知：近窗 stall 且无在途，允许一次窄 repair',
      strategyId,
    };
  }

  return {
    kpiId: kpi.kpiId,
    action:
      `【本轮工作包·bootstrap】针对 KPI「${desc}」完成一次可验收的基线交付：` +
      `只做首轮必要采集/脚手架，写出明确产物文件；不要把「每日/持续」整段职责当成本次 goal。`,
    expectedOutcome: `至少 1 个非空产物文件，并说明覆盖了职责的哪一块基线`,
    reason: '感知：尚无成功基线 burst，允许一次窄 bootstrap',
    strategyId,
  };
}

export function calendarKeyForKpi(kpiId: string, seedKind = 'increment'): string {
  return `${kpiId}:${seedKind}`;
}

/** 窄 prompt：写入周期日历，due 时执行（非 Duty 全文） */
export function buildPeriodicIncrementPrompt(kpi: {
  kpiId: string;
  description: string;
  sinceAt?: string;
}): string {
  const desc = shortDesc(kpi.description);
  const windowHint = kpi.sinceAt?.trim()
    ? `只采集自 ${kpi.sinceAt.trim()} 以来的增量`
    : `只采集自上次成功交付以来的增量窗口（如 24h）`;
  return (
    `【日历到期·increment】KPI ${kpi.kpiId}\n` +
    `职责摘要：${desc}\n\n` +
    `${windowHint}，更新报告产物；` +
    `禁止重做「首次全量基线」。完成后登记 deliverable。`
  );
}

/**
 * ADV-6 / §3 规则 7：基线已完成且尚无未到期周期承诺 → 幂等 ensure 一条增量日历。
 * needingRepair 的 KPI 先让 SelfWork repair，此处跳过。
 * @returns { created, noop } 计数供 P3 指标
 */
export async function ensureCalendarsAfterBootstrap(opts: {
  kpis: Array<Pick<SelfWorkKpi, 'kpiId' | 'description'>>;
  perception: AdvancePerception;
  agentId: string;
  ensure: (
    input: EnsurePeriodicCommitmentInput,
  ) => Promise<{ created: boolean; id: string }>;
}): Promise<{ created: number; results: Array<{ kpiId: string; calendarKey: string; created: boolean }> }> {
  const results: Array<{ kpiId: string; calendarKey: string; created: boolean }> = [];
  let created = 0;
  for (const kpi of opts.kpis) {
    if (!opts.perception.kpiIdsBootstrapDone.includes(kpi.kpiId)) continue;
    if (opts.perception.kpiIdsNeedingRepair.includes(kpi.kpiId)) continue;
    if (opts.perception.kpiIdsWithFuturePeriodicCalendar.includes(kpi.kpiId)) continue;
    if (opts.perception.kpiIdsWithInFlight.includes(kpi.kpiId)) continue;
    if (opts.perception.kpiIdsWithHealthyRunning.includes(kpi.kpiId)) continue;

    const calendarKey = calendarKeyForKpi(kpi.kpiId);
    const result = await opts.ensure({
      calendarKey,
      kpiId: kpi.kpiId,
      title: `KPI 增量：${shortDesc(kpi.description)}`,
      expectedOutcome: '一次增量窗口内的可验收产物更新',
      prompt: buildPeriodicIncrementPrompt({
        ...kpi,
        sinceAt: opts.perception.sinceAtByKpi[kpi.kpiId],
      }),
      agentId: opts.agentId,
    });
    results.push({ kpiId: kpi.kpiId, calendarKey, created: result.created });
    if (result.created) created += 1;
  }
  return { created, results };
}
