/**
 * M10 · LLM Adapter
 *
 * 抽象 LLM 调用接口，屏蔽具体 provider 差异。
 * 默认实现：OpenAI Chat Completions API。
 */

/** 纯文本 content block（OpenAI vision 格式） */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/** 图片 content block。url 可为 data:image/...;base64,... 或 https:// 公开 URL */
export interface ImageContentBlock {
  type: 'image_url';
  image_url: {
    url:    string;
    /** 'auto' | 'low' | 'high'，默认 auto */
    detail?: 'auto' | 'low' | 'high';
  };
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

/** Assistant 消息中的单条 tool call（回传 API 时必带，否则 tool_call_id 无法匹配） */
export interface ToolCallPart {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * 纯文本时直接用 string（向后兼容）。
   * 含图片等富媒体时用 ContentBlock[]（OpenAI vision 格式）。
   */
  content: string | ContentBlock[];
  /** 仅 role=tool 时必填，与 assistant tool_calls 的 id 对应（OpenAI/Kimi 要求） */
  tool_call_id?: string;
  /** 仅 role=assistant 且本轮有工具调用时必填，与后续 tool 消息的 tool_call_id 对应 */
  tool_calls?: ToolCallPart[];
}

export interface LLMResult {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

export interface StreamChunk {
  /** 新增的文本片段（delta） */
  delta: string;
  /** 本 chunk 是否为最后一个 */
  done: boolean;
}

export interface LLMAdapter {
  /** 非流式：等待完整响应 */
  chat(
    systemPrompt: string,
    messages: Message[],
    tools?: object[]
  ): Promise<LLMResult>;

  /** 流式：逐 chunk 回调，返回最终完整结果 */
  stream?(
    systemPrompt: string,
    messages: Message[],
    onChunk: (chunk: StreamChunk) => void
  ): Promise<LLMResult>;
}

export { createOpenAIAdapter, type ToolWireFormat } from './openai.js';
export { createGLMAdapter } from './glm.js';
export { createLocalModuleAdapter } from './localmodule.js';
