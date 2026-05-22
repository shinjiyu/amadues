import type { ZhipuChatOptions } from './types.js';
import { llmRawChatCompletion } from '../llm/raw.js';

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; code?: string };
}

/**
 * 智谱 chat/completions（与 OpenAI 形态兼容）。
 * 文本模型见 GLM-5 系列：https://docs.bigmodel.cn/cn/guide/models/text/glm-5
 */
export async function zhipuChatCompletion(opts: ZhipuChatOptions): Promise<{ content: string; raw: unknown }> {
  const { raw } = await llmRawChatCompletion<CompletionResponse>({
    provider: 'zhipu',
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    body: {
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.6,
      thinking: { type: opts.thinking },
    },
  });
  const content = normalizeMessageContent(raw.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error('Zhipu: empty content');
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
