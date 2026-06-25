/**
 * IM 入站上下文装配 — ADL IM-INBOUND-INTENT-ROUTING.md §4（方案一，2026-06-24）
 *
 * 方案一：前置层**不派发任何任务/KPI**。它只做**只读**上下文装配
 * （本 origin 的 active KPI + 在跑/等待 burst），渲染成 `inboundHint` 注入对话环。
 * 派发决策（set_goal / set_kpi / advance_kpi / send_directive）全部由**对话环 LLM** 用工具完成。
 *
 * 取代旧 `routeInboundKpiOrAdHoc`（软闸门 + 高置信短路派发）。
 */
import type { KpiRegistry } from '../kpi-registry.js';
import type { InnerBrainRegistry, TaskStatus } from '../inner-brain-registry.js';

export interface InboundContextDeps {
  kpiRegistry: KpiRegistry;
  innerBrainRegistry?: InnerBrainRegistry;
  defaultThreadId: string;
  originUser: string;
}

export interface InboundLiveBurst {
  instanceId: string;
  goal: string;
  status: TaskStatus;
}

export interface InboundContext {
  /** 本 origin 创建的 active KPI（供 LLM 去重 / advance 而非新建） */
  activeKpis: { kpiId: string; description: string }[];
  /** 本 thread / origin 在跑或等待的 burst（供 LLM send_directive / 报状态） */
  liveBursts: InboundLiveBurst[];
}

/** 在跑/等待中的既有任务状态 */
const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(['RUNNING', 'BLOCKED', 'AWAITING']);

const MAX_HINT_KPIS = 6;
const MAX_HINT_BURSTS = 6;
const HINT_DESC_MAX = 80;

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 组装只读入站上下文（零副作用）：
 *  - activeKpis：本 originUser 的 active KPI
 *  - liveBursts：本 thread/origin 在跑或等待的 burst（按最近开始排序）
 */
export function assembleInboundContext(deps: InboundContextDeps): InboundContext {
  const activeKpis = deps.kpiRegistry
    .list({ status: 'active' })
    .filter((k) => k.createdBy === deps.originUser)
    .map((k) => ({ kpiId: k.kpiId, description: k.description }));

  const liveBursts: InboundLiveBurst[] = [];
  const innerRegistry = deps.innerBrainRegistry;
  if (innerRegistry) {
    for (const t of innerRegistry
      .list()
      .filter(
        (t) =>
          LIVE_STATUSES.has(t.status) &&
          (t.originThread === deps.defaultThreadId || t.originUser === deps.originUser),
      )
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))) {
      liveBursts.push({ instanceId: t.instanceId, goal: t.goal, status: t.status });
    }
  }

  return { activeKpis, liveBursts };
}

/**
 * 渲染入站上下文为对话环系统提示块（只读、建议性、不强制动作）。
 * 始终返回提示块（含决策指引），即使无 active KPI / burst（引导 LLM 不要为闲聊乱建 KPI）。
 */
export function renderInboundHint(ctx: InboundContext): string {
  const kpiLines =
    ctx.activeKpis.length > 0
      ? ctx.activeKpis
          .slice(0, MAX_HINT_KPIS)
          .map((k) => `  - \`${k.kpiId}\` ${clip(k.description, HINT_DESC_MAX)}`)
          .join('\n') +
        (ctx.activeKpis.length > MAX_HINT_KPIS
          ? `\n  - …另有 ${ctx.activeKpis.length - MAX_HINT_KPIS} 个`
          : '')
      : '  - （无）';

  const burstLines =
    ctx.liveBursts.length > 0
      ? ctx.liveBursts
          .slice(0, MAX_HINT_BURSTS)
          .map((b) => `  - \`${b.instanceId}\` [${b.status}] ${clip(b.goal, HINT_DESC_MAX)}`)
          .join('\n') +
        (ctx.liveBursts.length > MAX_HINT_BURSTS
          ? `\n  - …另有 ${ctx.liveBursts.length - MAX_HINT_BURSTS} 个`
          : '')
      : '  - （无）';

  return (
    '【入站上下文（只读，供你决策；不强制动作）】\n' +
    '- 本人 active KPI：\n' +
    kpiLines +
    '\n- 在跑/等待 burst：\n' +
    burstLines +
    '\n- 提示：模糊/寒暄/自我介绍/纯追问直接回答；确需长期跟进才 set_kpi；一次性杂活用 set_goal；' +
    '追问在跑任务用 send_directive；切忌为闲聊新建 KPI 或重复已存在的 KPI。'
  );
}
