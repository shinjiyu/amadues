import type { LlmChatOptions, LlmChatResult } from '../types.js';
import { llmRawChatCompletion } from '../raw.js';

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; code?: string };
}

/**
 * PocketCity `ai.pocketcity.com` 等 OpenAI-compatible 网关。
 * 仅标准 chat/completions 字段，不附带 Kimi/智谱专有字段。
 */
export async function localmoduleProviderChatCompletion(
  opts: Omit<LlmChatOptions, 'provider'>,
): Promise<LlmChatResult> {
  const { raw } = await llmRawChatCompletion<CompletionResponse>({
    provider: 'localmodule',
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    usageMeta: { source: 'inner_llm_step', model: opts.model, provider: 'localmodule', ...opts.usageMeta },
    body: {
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.5,
      // thinking 规整在 raw.ts::normalizeProviderRequestBody 完成（透传给 GLM 网关）。
      thinking: opts.thinking,
    },
  });

  const content = normalizeMessageContent(raw.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error('LocalModule: empty content');
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
