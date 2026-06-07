/**
 * IM 入站意图分类 — ADL KPI-ADVANCEMENT.md §2
 */
export type ImInboundIntent =
  | { kind: 'kpi_create'; description: string; notes?: string; ongoing: boolean }
  | { kind: 'kpi_update'; description: string; notes?: string }
  | { kind: 'ad_hoc_task'; goal: string }
  | { kind: 'chat_only' };

const KPI_SIGNAL_RE =
  /持续|长期|常驻|每天|每日|定期|周期|常态|汇报|简报|监控|采集|情报体系|KPI|目标|任务线/i;
const ADHOC_SIGNAL_RE =
  /帮我(查|看|改|写|翻译|总结)|一下|这张图|这个文件|顺便/i;

export function classifyImInboundIntent(text: string): ImInboundIntent {
  const t = text.trim();
  if (!t) return { kind: 'chat_only' };

  const ongoing =
    /持续|长期|常驻|每天|每日|定期|周期|常态|24\s*h|24小时/i.test(t);
  const kpiLike = KPI_SIGNAL_RE.test(t) && t.length >= 8;
  const adHocLike = ADHOC_SIGNAL_RE.test(t) && !ongoing && t.length < 200;

  if (kpiLike && !adHocLike) {
    return {
      kind: 'kpi_create',
      description: t,
      ongoing: ongoing || /汇报|简报|采集|监控/.test(t),
    };
  }

  if (adHocLike && !kpiLike) {
    return { kind: 'ad_hoc_task', goal: t };
  }

  if (kpiLike) {
    return {
      kind: 'kpi_create',
      description: t,
      ongoing,
    };
  }

  return { kind: 'chat_only' };
}
