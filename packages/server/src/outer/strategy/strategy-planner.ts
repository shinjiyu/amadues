/**
 * 战略规划层 — strategyPlanner.plan()（ADL STRATEGY-PLANNING-LAYER.md §2b/§5/§12）。
 *
 * P0：REFLECT + DESIGN 合并为一次 LLM call，但 prompt/schema 两段必填（缺 WHY → reject）。
 * LLM caller 注入（便于 FakeLLM 单测）；解析失败 / schema reject → 回退 lastStrategy 或最小安全 artifact。
 * 唯一写权：plan() 产出的 artifact 由 strategyStore 落盘（编排在 facade）。
 */
import { validateStrategyArtifact } from './strategy-artifact.js';
import {
  DEFAULT_REEVALUATE_POLICY,
  DEFAULT_STALE_AWAITING_POLICY,
  type StrategyArtifact,
  type StrategyPlanInput,
} from './strategy-types.js';

export type StrategyLlmCaller = (req: { system: string; user: string }) => Promise<string>;

export interface PlanNextDeps {
  callLlm: StrategyLlmCaller;
  now?: () => number;
}

export interface PlanNextResult {
  artifact: StrategyArtifact;
  rejected: boolean;
  rejectErrors: string[];
  rawText: string;
}

const SYSTEM_PROMPT = [
  '你是外脑的战略规划器。看完 KPI 现状、最近 burst 行为、环境事件后，',
  '先回答 WHY（这些 KPI 为何仍值得推 / 有何 lesson / 是否该 paused），再回答 HOW（focusOrder 顺序 / 下一 burst 角度）。',
  '只输出一个 JSON 对象，字段：',
  'theory(string, WHY 战略假设), whyNow(string, WHY 为何现在), nextExpectation(string, HOW 下一 burst 预期),',
  'focusOrder(string[] KPI id 按优先级), activeKpis(string[] ⊆ active), pausedKpis([{id,reason}]),',
  'recentLessons([{burstId,takeaway}]), cullDirectives([{burstInstanceId,reason,grace}]).',
  '禁止只写 HOW 不写 WHY：theory 与 whyNow 必须是有意义的句子，否则视为无效。',
].join('\n');

function buildUserPrompt(input: StrategyPlanInput): string {
  const kpiLines = input.kpis
    .map(
      (k) =>
        `- ${k.id} [${k.status}${k.kind ? '/' + k.kind : ''}${
          typeof k.momentum === 'number' ? ' m=' + k.momentum : ''
        }] ${k.title}${k.reflexionDigest ? ' | ' + k.reflexionDigest : ''}`,
    )
    .join('\n');
  const burstLines = input.recentBursts
    .map(
      (b) =>
        `- ${b.instanceId}${b.kpiId ? '(' + b.kpiId + ')' : ''} ${b.state}${
          b.reflexionSummary ? ': ' + b.reflexionSummary : ''
        }`,
    )
    .join('\n');
  const eventLines = input.envEvents.map((e) => `- [${e.sensorId}.${e.field}] ${e.note}`).join('\n');
  return [
    `# KPI（active+paused）\n${kpiLines || '(无)'}`,
    `# 最近 burst\n${burstLines || '(无)'}`,
    `# 环境事件（未消费）\n${eventLines || '(无)'}`,
    input.envDigest ? `# 环境要点\n${input.envDigest}` : '',
    input.lastStrategy
      ? `# 上一份战略\nfocusOrder=${JSON.stringify(input.lastStrategy.focusOrder)}\ntheory=${input.lastStrategy.theory}`
      : '# 上一份战略\n(无，首次规划)',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 从 LLM 文本里抠出第一个 JSON 对象（容忍 ```json 围栏与前后噪声） */
export function extractJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 回退 artifact：优先复用 lastStrategy（与当前 active 取交集），否则按 active 列表造最小安全战略 */
export function buildFallbackArtifact(
  input: StrategyPlanInput,
  activeKpiIds: string[],
  nowIso: string,
): StrategyArtifact {
  const last = input.lastStrategy;
  const activeSet = new Set(activeKpiIds);
  if (last) {
    const focusOrder = last.focusOrder.filter((id) => activeSet.has(id));
    if (focusOrder.length > 0) {
      return { ...last, focusOrder, activeKpis: focusOrder, updatedAt: nowIso, cullDirectives: [] };
    }
  }
  // 无可用上一份战略：按 momentum 降序排 active（与 dispatcher interim 一致），不发 cull
  const ordered = [...input.kpis]
    .filter((k) => activeSet.has(k.id))
    .sort((a, b) => (b.momentum ?? 0) - (a.momentum ?? 0))
    .map((k) => k.id);
  return {
    version: 1,
    agentId: input.agentId,
    updatedAt: nowIso,
    activeKpis: ordered,
    focusOrder: ordered,
    pausedKpis: [],
    theory: '(fallback) 规划器输出无效，暂按既有 active KPI 维持推进。',
    whyNow: '(fallback) 沿用上轮方向，待下次有效 reflect 重定。',
    recentLessons: [],
    nextExpectation: '(fallback) 维持当前 focusOrder 推进一个 burst。',
    cullDirectives: [],
    staleAwaitingPolicy: { ...DEFAULT_STALE_AWAITING_POLICY },
    reEvaluateAfter: { ...DEFAULT_REEVALUATE_POLICY },
  };
}

export async function planNext(input: StrategyPlanInput, deps: PlanNextDeps): Promise<PlanNextResult> {
  const nowIso = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const activeKpiIds = input.kpis.filter((k) => k.status === 'active').map((k) => k.id);

  let rawText = '';
  try {
    rawText = await deps.callLlm({ system: SYSTEM_PROMPT, user: buildUserPrompt(input) });
  } catch (err) {
    return {
      artifact: buildFallbackArtifact(input, activeKpiIds, nowIso),
      rejected: true,
      rejectErrors: [`llm_error:${(err as Error)?.message ?? 'unknown'}`],
      rawText: '',
    };
  }

  const parsed = extractJsonObject(rawText);
  if (parsed === null) {
    return {
      artifact: buildFallbackArtifact(input, activeKpiIds, nowIso),
      rejected: true,
      rejectErrors: ['parse_failed'],
      rawText,
    };
  }
  const result = validateStrategyArtifact(parsed, { agentId: input.agentId, activeKpiIds, now: nowIso });
  if (result.ok && result.artifact) {
    return { artifact: result.artifact, rejected: false, rejectErrors: [], rawText };
  }
  return {
    artifact: buildFallbackArtifact(input, activeKpiIds, nowIso),
    rejected: true,
    rejectErrors: result.errors,
    rawText,
  };
}
