/**
 * AWAITING burst LLM 审查 — ADL KPI-MANAGER-LAYER.md §3.1 R3（P3）
 */
import { llmRawChatCompletion } from '../../llm/raw.js';
import type { InnerLlmEnv } from '../../llm/inner-llm-step.js';
import type { BrainAsyncSnapshot } from '../brain-async-snapshot.js';
import type { TaskRecord } from '../inner-brain-registry.js';

export interface AwaitingReviewLlmVerdict {
  reasonable: boolean;
  reason?: string;
}

export type AwaitingReviewLlmCaller = (prompt: string) => Promise<string>;

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseAwaitingReviewLlmResponse(text: string): AwaitingReviewLlmVerdict | null {
  const raw = extractJsonObject(text.trim());
  if (!raw || typeof raw.reasonable !== 'boolean') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : undefined;
  return { reasonable: raw.reasonable, reason: reason || undefined };
}

export function buildAwaitingReviewPrompt(rec: TaskRecord, snap: BrainAsyncSnapshot): string {
  const pendings = snap.active_pendings
    .map((p) => `- ${p.kind} (${p.status})${p.execute_at ? ` at ${p.execute_at}` : ''}`)
    .join('\n');
  return (
    `内脑 burst ${rec.instanceId} 处于 AWAITING。\n\n` +
    `goal: ${rec.goal.slice(0, 400)}\n` +
    `controller.mode: ${snap.controller.mode ?? 'null'}\n` +
    `is_async_waiting: ${snap.is_async_waiting}\n` +
    `has_ask_user_pending: ${snap.has_ask_user_pending}\n` +
    `active_pendings:\n${pendings || '(none)'}\n\n` +
    `判断：该 AWAITING 是否**合理**（在等有效异步信号 / timer / 外部事件）？\n` +
    `若不合理（空转、无 pending 却挂起、timer 已过期仍等）应 stop 后换方案续派。\n\n` +
    `只输出 JSON：{"reasonable":true|false,"reason":"简短说明"}`
  );
}

export async function classifyAwaitingWithLlm(
  rec: TaskRecord,
  snap: BrainAsyncSnapshot,
  callLlm: AwaitingReviewLlmCaller,
): Promise<AwaitingReviewLlmVerdict | null> {
  try {
    const text = await callLlm(buildAwaitingReviewPrompt(rec, snap));
    return parseAwaitingReviewLlmResponse(text);
  } catch {
    return null;
  }
}

/** 把 InnerLlmEnv 包成 kpiManager 可注入的 callLlm */
export function buildAwaitingReviewLlmCaller(env: InnerLlmEnv): AwaitingReviewLlmCaller {
  return async (prompt: string) => {
    const { raw } = await llmRawChatCompletion<{
      error?: { message?: string; code?: string };
      choices?: Array<{ message?: { content?: string } }>;
    }>({
      provider: env.provider,
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      usageMeta: { source: 'kpi_manager', model: env.textModel, provider: env.provider },
      body: {
        model: env.textModel,
        temperature: 0.2,
        max_tokens: 120,
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'system',
            content:
              '你是外脑 KPI 管理器的 AWAITING 审查员。只判断内脑挂起是否合理。' +
              '只输出 JSON：{"reasonable":true|false,"reason":"简短说明"}',
          },
          { role: 'user', content: prompt },
        ],
      },
    });
    return raw.choices?.[0]?.message?.content?.trim() ?? '';
  };
}

export function resolveAwaitingReviewLlmCaller(
  getLlmEnv: () => InnerLlmEnv | null,
): AwaitingReviewLlmCaller | undefined {
  const env = getLlmEnv();
  if (!env) return undefined;
  return buildAwaitingReviewLlmCaller(env);
}
