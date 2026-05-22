/** OpenAI 兼容 messages（智谱 v4 chat/completions） */

export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image_url'; image_url: { url: string } };

export type UserContent = string | (TextPart | ImagePart)[];

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContent }
  | { role: 'assistant'; content: string };

export interface ZhipuChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** 编码套餐/省 token：建议 disabled */
  thinking: 'enabled' | 'disabled';
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}
