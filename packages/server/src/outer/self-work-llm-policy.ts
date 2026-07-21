/**
 * llm_reflective SelfWorkPolicy — ADL DIGITAL-EMPLOYEE-AUTONOMY.md §4.2（P3）
 *
 * LLM 只有提案权：输出 JSON 提案或 {"sleep":true}；解析失败、非法提案或调用异常
 * 一律回退 deterministic fallback。合法性仍由 validateSelfWorkProposal 统一把关，
 * LLM 无法越过 hardGates / Calendar / set_goal 边界。
 */
import { llmRawChatCompletion } from '../llm/raw.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import {
  validateSelfWorkProposal,
  type SelfWorkContext,
  type SelfWorkPolicy,
  type SelfWorkProposal,
} from './self-work-policy.js';

export type SelfWorkLlmCaller = (prompt: string) => Promise<string>;

export const LLM_REFLECTIVE_STRATEGY_ID = 'llm_reflective';

export function buildSelfWorkPrompt(context: SelfWorkContext): string {
  const kpis = context.activeKpis
    .map(
      (kpi) =>
        `- ${kpi.kpiId}: ${kpi.description}` +
        (kpi.charter ? `（charter: ${kpi.charter.slice(0, 120)}）` : '') +
        `（momentum=${kpi.momentum}）`,
    )
    .join('\n');
  const list = (items: string[] | undefined, empty: string) =>
    items && items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;

  return [
    '你是数字员工的自主找活策略。当前有空闲执行容量，请为一个 active KPI 提出下一件最有价值的工作。',
    '',
    '## active KPI',
    kpis || '（无）',
    '',
    '## 最近已做（禁止重复）',
    list(context.recentActions.slice(-10), '（无）'),
    '',
    '## 被熔断的失败路线（禁止重试，换独立方向）',
    list(context.blockedRoutes, '（无）'),
    '',
    '## 未满足的依赖（依赖这些答案的工作不要提）',
    list(context.pendingDependencies, '（无）'),
    '',
    '## 在跑工作（勿写同一交付物）',
    list(context.runningConflicts, '（无）'),
    '',
    '要求：action 具体可执行；expectedOutcome 可验收；不重复、不依赖未满足条件。',
    '若没有真正有价值的工作，诚实输出 {"sleep":true}，禁止为了看起来忙而编造。',
    '',
    '只输出 JSON（二选一）：',
    '{"kpiId":"...","action":"...","expectedOutcome":"...","reason":"..."}',
    '{"sleep":true}',
  ].join('\n');
}

export interface ParsedSelfWorkLlmResponse {
  sleep: boolean;
  proposal?: SelfWorkProposal;
}

export function parseSelfWorkLlmResponse(text: string): ParsedSelfWorkLlmResponse | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed['sleep'] === true) return { sleep: true };

  const kpiId = typeof parsed['kpiId'] === 'string' ? parsed['kpiId'] : '';
  const action = typeof parsed['action'] === 'string' ? parsed['action'] : '';
  const expectedOutcome =
    typeof parsed['expectedOutcome'] === 'string' ? parsed['expectedOutcome'] : '';
  const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '';
  if (!kpiId || !action || !expectedOutcome) return null;

  return {
    sleep: false,
    proposal: {
      kpiId,
      action,
      expectedOutcome,
      reason: reason || 'LLM 提案',
      strategyId: LLM_REFLECTIVE_STRATEGY_ID,
    },
  };
}

export class LlmReflectiveSelfWorkPolicy implements SelfWorkPolicy {
  constructor(
    private readonly callLlm: SelfWorkLlmCaller,
    private readonly fallback?: SelfWorkPolicy,
  ) {}

  async propose(context: SelfWorkContext): Promise<SelfWorkProposal | null> {
    if (context.activeKpis.length === 0) return null;
    try {
      const text = await this.callLlm(buildSelfWorkPrompt(context));
      const parsed = parseSelfWorkLlmResponse(text);
      if (!parsed) return this.proposeFallback(context);
      if (parsed.sleep) return null;
      const proposal = parsed.proposal!;
      if (validateSelfWorkProposal(proposal, context).ok) return proposal;
      return this.proposeFallback(context);
    } catch {
      return this.proposeFallback(context);
    }
  }

  private proposeFallback(context: SelfWorkContext): Promise<SelfWorkProposal | null> {
    return this.fallback?.propose(context) ?? Promise.resolve(null);
  }
}

/** 把 InnerLlmEnv 包成可注入的 SelfWorkLlmCaller */
export function buildSelfWorkLlmCaller(env: InnerLlmEnv): SelfWorkLlmCaller {
  return async (prompt: string) => {
    const { raw } = await llmRawChatCompletion<{
      error?: { message?: string; code?: string };
      choices?: Array<{ message?: { content?: string } }>;
    }>({
      provider: env.provider,
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      usageMeta: { source: 'self_work_policy', model: env.textModel, provider: env.provider },
      body: {
        model: env.textModel,
        temperature: 0.4,
        max_tokens: 400,
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'system',
            content:
              '你是数字员工的自主找活策略。只输出 JSON：一个合法提案对象或 {"sleep":true}。',
          },
          { role: 'user', content: prompt },
        ],
      },
    });
    return raw.choices?.[0]?.message?.content?.trim() ?? '';
  };
}
