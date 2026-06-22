/**
 * IM 入站意图分类 — ADL KPI-ADVANCEMENT.md §2
 */
export type ImInboundIntent =
  | { kind: 'kpi_create'; description: string; notes?: string; ongoing: boolean }
  | { kind: 'kpi_update'; description: string; notes?: string }
  | { kind: 'ad_hoc_task'; goal: string }
  | { kind: 'chat_only' };

/** 登记新 KPI：长期/周期任务或明确「建立/启动」类表述（不含单独「汇报」— 易与查现状混淆） */
const KPI_CREATE_SIGNAL_RE =
  /持续|长期|常驻|每天|每日|定期|周期|常态|简报|监控|采集|情报体系|任务线|建立|创建|新增|启动|设定/i;

/** 只读：查/汇报已有 KPI → 走对话环 list_kpis / view_kpi，禁止 create+advance */
const KPI_QUERY_RE =
  /(?:汇报|查看|列出|说说|告诉|报一下|说一下|有哪些|什么是|啥).*(?:当前|你们|现有|进行|active)?.*(?:KPI|kpi|目标)|(?:KPI|kpi|目标).*(?:汇报|状态|进展|情况|列表|清单)|^(?:你们)?(?:当前|现在)?(?:有)?(?:哪些|什么).*(?:KPI|kpi|目标)/i;

const ADHOC_SIGNAL_RE =
  /帮我(查|看|改|写|翻译|总结)|一下|这张图|这个文件|顺便/i;

/** 去掉 @mention，避免「@Gin 汇报 KPI」只剩噪声 */
export function stripImMentions(text: string): string {
  return text.replace(/@[\w\u4e00-\u9fff-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isKpiQueryIntent(text: string): boolean {
  const t = stripImMentions(text);
  if (!t) return false;
  return KPI_QUERY_RE.test(t);
}

export function classifyImInboundIntent(text: string): ImInboundIntent {
  const t = stripImMentions(text);
  if (!t) return { kind: 'chat_only' };

  if (isKpiQueryIntent(t)) {
    return { kind: 'chat_only' };
  }

  const ongoing =
    /持续|长期|常驻|每天|每日|定期|周期|常态|24\s*h|24小时/i.test(t);
  const hasKpiKeyword = /KPI|kpi|目标|任务线/i.test(t);
  const hasCreateSignal = KPI_CREATE_SIGNAL_RE.test(t);
  /** 需「创建类信号」或（KPI 词 + 足够长的任务描述）；单提 KPI/目标 不建单 */
  const kpiLike =
    t.length >= 8 &&
    (hasCreateSignal || (hasKpiKeyword && /建立|创建|新增|启动|设定|做一|帮我做/i.test(t)));
  const adHocLike = ADHOC_SIGNAL_RE.test(t) && !ongoing && t.length < 200;

  if (kpiLike && !adHocLike) {
    return {
      kind: 'kpi_create',
      description: text.trim(),
      ongoing: ongoing || /简报|采集|监控|每天|每日|定期/.test(t),
    };
  }

  if (adHocLike && !kpiLike) {
    return { kind: 'ad_hoc_task', goal: text.trim() };
  }

  if (kpiLike) {
    return {
      kind: 'kpi_create',
      description: text.trim(),
      ongoing,
    };
  }

  return { kind: 'chat_only' };
}
