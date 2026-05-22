/** Provider-neutral OpenAI-compatible chat types. */

export type LlmProvider = 'zhipu' | 'kimi' | 'localmodule';

export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image_url'; image_url: { url: string } };

export type UserContent = string | (TextPart | ImagePart)[];

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContent }
  | { role: 'assistant'; content: string };

export interface LlmChatOptions {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  thinking: 'enabled' | 'disabled';
}

export interface LlmEnv {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  textModel: string;
  /** 多模态（图+文）单次调用模型。Kimi 可与 textModel 相同。 */
  visionModel: string;
  maxTokensText: number;
  maxTokensMultimodal: number;
  thinking: 'enabled' | 'disabled';
}

export interface LlmChatResult {
  content: string;
  raw: unknown;
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}
