import type { LlmChatOptions, LlmChatResult } from '../types.js';
import { llmRawChatCompletion } from '../raw.js';

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; code?: string };
}

/**
 * Kimi (Moonshot) chat/completions provider.
 *
 * 使用 OpenAI-compatible 端点，但保留 provider 专属行为：
 * - `kimi-k2.6` 当前要求 temperature 固定为 0.6；否则会返回 400。
 * - thinking 字段使用与现有 OpenAI-compatible 路径一致的 `{ type }` 形态。
 */
export async function kimiProviderChatCompletion(
  opts: Omit<LlmChatOptions, 'provider'>,
): Promise<LlmChatResult> {
  const { raw } = await llmRawChatCompletion<CompletionResponse>({
    provider: 'kimi',
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    usageMeta: { source: 'inner_llm_step', model: opts.model, provider: 'kimi', ...opts.usageMeta },
    body: {
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: normalizeKimiTemperature(opts.model, opts.temperature),
      thinking: { type: opts.thinking },
    },
  });

  const content = normalizeMessageContent(raw.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error('Kimi: empty content');
  }
  return { content, raw };
}

function normalizeKimiTemperature(model: string, requested?: number): number {
  // 截至 2026-05，kimi-k2.6 仅接受 temperature=0.6。
  if (model.trim() === 'kimi-k2.6') return 0.6;
  return requested ?? 0.5;
}

function normalizeMessageContent(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return String((part as { text: string }).text);
        }
        return '';
      })
      .join('');
  }
  return String(c);
}
