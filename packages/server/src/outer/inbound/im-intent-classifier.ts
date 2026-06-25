/**
 * IM 入站意图分类 — ADL IM-INBOUND-INTENT-ROUTING.md §2/§3/§6
 *
 * 设计要点（取代旧 KPI-ADVANCEMENT §2）：
 *  - **默认 chat_only**：模糊消息交对话环，不在前置层替 LLM 决定建 KPI。
 *  - **收窄 KPI 正则**：去掉裸 `启动/设定/新增`，仅显式长期/周期才高置信 create。
 *  - **task_followup**：指向既有任务/KPI 的追问，绝不新建。
 *  - **去重降级**：显式 KPI 但已有近似 active KPI → kpi_update。
 *  - **一次性即 ad-hoc**：IM 不铸 delivery KPI；kpi_create 只产 ongoing。
 */
import { isSimilarKpiDescription } from './kpi-description-similarity.js';

export interface ExistingWorkRef {
  kind: 'burst' | 'kpi';
  id: string;
  matchReason: 'recent_thread' | 'deictic_followup' | 'explicit_id' | 'in_flight';
}

export type ImInboundIntent =
  | { kind: 'chat_only' }
  | { kind: 'task_followup'; ref: ExistingWorkRef; note: string }
  | { kind: 'ad_hoc_task'; goal: string }
  | { kind: 'kpi_update'; kpiId: string; note: string }
  | { kind: 'kpi_create'; description: string; ongoing: true; confirmed: boolean };

/** 分类上下文（由 inboundKpiRouter 按 origin 过滤后注入）；纯函数靠它感知既有任务 */
export interface ImClassifyContext {
  /** 本 origin 的 active KPI（去重 + kpi_update 目标） */
  activeKpis?: { kpiId: string; description: string }[];
  /** 本 thread 在跑/等待的既有任务引用（追问转 task_followup） */
  followupRef?: ExistingWorkRef;
}

/**
 * 高置信「显式长期/周期 KPI」信号。
 * 注意：**不含**裸 `启动/设定/新增`（旧设计误触发的根因）；`建立/创建/设立` 需配 KPI/长期名词。
 */
const KPI_CREATE_EXPLICIT_RE =
  /持续|长期|常驻|每天|每日|定期|周期|常态|监控|简报|情报体系|任务线|长期跟进|立(?:个|一个)?\s*KPI/i;

/** 创建命令动词 + KPI/长期名词 的组合（次高置信） */
const CREATE_VERB_RE = /建立|创建|设立|开设|设置/i;
const KPI_NOUN_RE = /KPI|目标|任务线|体系|机制|流程/i;

/** 只读：查/汇报已有 KPI → chat_only（禁止 create+advance） */
const KPI_QUERY_RE =
  /(?:汇报|查看|列出|说说|告诉|报一下|说一下|有哪些|什么是|啥).*(?:当前|你们|现有|进行|active)?.*(?:KPI|kpi|目标)|(?:KPI|kpi|目标).*(?:汇报|状态|进展|情况|列表|清单)|^(?:你们)?(?:当前|现在)?(?:有)?(?:哪些|什么).*(?:KPI|kpi|目标)/i;

/**
 * 一次性杂活信号（高置信祈使）。
 * 注意：**绝不**含裸口语助词 `一下`（旧版误把「介绍一下自己」「说一下看法」派成 ad-hoc 任务，D8 根因）。
 * 须「祈使前缀 + 动作动词」或明确产物指代；其余一律落 chat_only 交对话环。
 */
const ADHOC_SIGNAL_RE =
  /(?:帮我|帮忙|麻烦你?|替我|给我)\s*(?:查|看|改|写|翻译|总结|处理|分析|整理|下载|生成|做)|这张图|这(?:个|份)文件|这(?:个|份)文档|顺便(?:帮|查|看|做)/i;

/** 跟进既有任务的指代信号（追问、催促、确认） */
const FOLLOWUP_RE =
  /再试|再来|再跑|再弄|继续|接着|怎么样了|好了吗|完成了吗|搞定了吗|是这样|对不对|对吗|刚才那个|刚刚那个|那个(?:项目|任务|事)|之前(?:那个|说的)/i;

/** 去掉 @mention，避免「@Gin 汇报 KPI」只剩噪声 */
export function stripImMentions(text: string): string {
  return text.replace(/@[\w\u4e00-\u9fff-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isKpiQueryIntent(text: string): boolean {
  const t = stripImMentions(text);
  if (!t) return false;
  return KPI_QUERY_RE.test(t);
}

/** 是否高置信显式 KPI 创建意图 */
function hasExplicitKpiSignal(t: string): boolean {
  if (KPI_CREATE_EXPLICIT_RE.test(t)) return true;
  if (CREATE_VERB_RE.test(t) && KPI_NOUN_RE.test(t)) return true;
  return false;
}

export function classifyImInboundIntent(
  text: string,
  ctx: ImClassifyContext = {},
): ImInboundIntent {
  const t = stripImMentions(text);
  if (!t) return { kind: 'chat_only' };

  // 1. KPI 只读查询 → chat_only
  if (isKpiQueryIntent(t)) return { kind: 'chat_only' };

  const explicitKpi = hasExplicitKpiSignal(t);
  const isFollowup = FOLLOWUP_RE.test(t);

  // 2. 去重降级：显式 KPI 但已有近似 active KPI → kpi_update（不重复 create）
  if (explicitKpi && ctx.activeKpis?.length) {
    const dup = ctx.activeKpis.find((k) => isSimilarKpiDescription(k.description, t));
    if (dup) return { kind: 'kpi_update', kpiId: dup.kpiId, note: text.trim() };
  }

  // 3. 跟进既有任务（且非显式新 KPI）→ task_followup；无既有任务则 chat_only
  if (isFollowup && !explicitKpi) {
    if (ctx.followupRef) {
      return { kind: 'task_followup', ref: ctx.followupRef, note: text.trim() };
    }
    return { kind: 'chat_only' };
  }

  // 4. 高置信显式长期/周期 → kpi_create（仅 ongoing；P1 显式即视为已确认，确认闸 P3）
  if (explicitKpi) {
    return { kind: 'kpi_create', description: text.trim(), ongoing: true, confirmed: true };
  }

  // 5. 高置信一次性杂活 → ad_hoc_task
  if (ADHOC_SIGNAL_RE.test(t) && t.length < 200) {
    return { kind: 'ad_hoc_task', goal: text.trim() };
  }

  // 6. 默认：交对话环（LLM 可自行用工具建 KPI / 派 ad-hoc）
  return { kind: 'chat_only' };
}
