import type { LlmChatOptions, LlmChatResult } from '../types.js';
import { llmRawChatCompletion } from '../raw.js';

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; code?: string };
}

/**
 * DeepSeek OpenAI-compatible chat/completions.
 * Model id `deepseek-flash` is served by DeepSeek-V4.1-Flash-1017.
 * Do not send Kimi/GLM `thinking` — Flash defaults to non-thinking.
 */
export async function deepseekProviderChatCompletion(
  opts: Omit<LlmChatOptions, 'provider'>,
): Promise<LlmChatResult> {
  const { raw } = await llmRawChatCompletion<CompletionResponse>({
    provider: 'deepseek',
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    usageMeta: { source: 'inner_llm_step', model: opts.model, provider: 'deepseek', ...opts.usageMeta },
    body: {
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.5,
    },
  });

  const content = normalizeMessageContent(raw.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error('DeepSeek: empty content');
  }
  return { content, raw };
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
