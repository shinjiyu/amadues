import type { LLMAdapter, LLMResult, StreamChunk, Message, ContentBlock } from './index.js';
import {
  beginLlmCall,
  endLlmCall,
  recordLlmUsageFromResponse,
} from '../../outer/llm-usage-tracker.js';

// ── OpenAI wire types ─────────────────────────────────────────────────────────

interface OAIStreamDelta {
  content?: string | null;
  tool_calls?: Array<{ index: number; id?: string; function: { name?: string; arguments?: string } }>;
}

interface OAIStreamChunk {
  choices: Array<{ delta: OAIStreamDelta; finish_reason: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * 流式响应：两次收到字节之间的最大间隔（毫秒）。只要持续有 chunk 就不会超时。
 * 默认 300s；设为 0 表示不限制（仅建议本地调试，生产可能无限挂起）。
 * 若未设置本变量但设置了旧变量 LLM_TIMEOUT_MS，则回退用其值，便于迁移。
 */
function resolveStreamIdleMs(): number {
  const raw = process.env['LLM_STREAM_IDLE_MS']?.trim();
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw.replace(/_/g, ''), 10);
    return Number.isFinite(n) ? n : 300_000;
  }
  const legacy = process.env['LLM_TIMEOUT_MS']?.trim();
  if (legacy !== undefined && legacy !== '') {
    const n = parseInt(legacy, 10);
    return Number.isFinite(n) ? n : 300_000;
  }
  return 300_000;
}

const LLM_STREAM_IDLE_MS = resolveStreamIdleMs();

/** setTimeout 安全上限（约 24.8 天） */
const MAX_TIMER_MS = 0x7fffffff;

async function readNextStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const effective = idleMs <= 0 ? MAX_TIMER_MS : Math.min(idleMs, MAX_TIMER_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`LLM stream idle timeout: no chunk for ${effective}ms`));
    }, effective);
  });
  try {
    const result = await Promise.race([reader.read(), timeoutPromise]);
    return result as ReadableStreamReadResult<Uint8Array>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Retry 配置 ────────────────────────────────────────────────────────────────

/** 可自动重试的 HTTP 状态码（速率限制 & 服务端瞬时错误）。 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** 最大重试次数（不含首次调用）。 */
const LLM_MAX_RETRIES = parseInt(process.env['LLM_MAX_RETRIES'] ?? '4', 10);

/**
 * 计算第 attempt 次（0-indexed）重试前的等待时间（毫秒）。
 *
 * - 429 速率限制：初始 10s，指数退避，上限 120s
 * - 5xx 服务端错误：初始 2s，指数退避，上限 30s
 *
 * 若响应头含 Retry-After，则取其值与计算值的较大者。
 */
function calcRetryDelay(status: number, attempt: number, retryAfterHeader: string | null): number {
  const base   = status === 429 ? 10_000 : 2_000;
  const cap    = status === 429 ? 120_000 : 30_000;
  const jitter = Math.random() * 1000;                     // ±1s 抖动
  let delay  = Math.min(base * Math.pow(2, attempt), cap) + jitter;

  // 优先尊重服务端 Retry-After 指示（秒 → 毫秒）
  if (retryAfterHeader) {
    const headerSec = parseInt(retryAfterHeader, 10);
    if (!isNaN(headerSec) && headerSec > 0) {
      delay = Math.max(delay, headerSec * 1000);
    }
  }
  return delay;
}

/**
 * 带指数退避重试的 fetch 封装。
 * 遇到 RETRYABLE_STATUSES 中的状态码时自动等待并重试，超出次数后抛出错误。
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;

    const isRetryable = RETRYABLE_STATUSES.has(res.status);
    // 非重试状态码，或已超出重试次数 → 直接抛出
    if (!isRetryable || attempt >= LLM_MAX_RETRIES) {
      const body = await res.text();
      throw new Error(`${label} error ${res.status}: ${body}`);
    }

    const retryAfter = res.headers.get('Retry-After');
    // 必须消耗响应体，否则连接不会被释放
    await res.text();

    const waitMs = calcRetryDelay(res.status, attempt, retryAfter);
    console.warn(
      `[llm-retry] HTTP ${res.status} (${label}), attempt ${attempt + 1}/${LLM_MAX_RETRIES}, ` +
      `waiting ${Math.round(waitMs / 1000)}s before retry…`,
    );
    await new Promise<void>((r) => setTimeout(r, waitMs));
  }
  throw new Error(`${label} failed after ${LLM_MAX_RETRIES} retries`);
}

// ── Adapter factory ───────────────────────────────────────────────────────────

/**
 * 工具调用在请求体中的线格式，不同模型要求不同：
 * - openai: 要求 assistant 消息带 tool_calls（含 id），tool 消息带 tool_call_id（OpenAI/Kimi）
 * - minimal: assistant 仅 content，tool 带 tool_call_id（GLM 等，与旧版行为一致）
 */
export type ToolWireFormat = 'openai' | 'minimal';

export function createOpenAIAdapter(options?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * 工具调用的线格式。minimal=兼容 GLM（不往 assistant 写 tool_calls）；openai=OpenAI/Kimi 严格格式。
   * 也可通过环境变量 OPENAI_TOOL_WIRE_FORMAT=openai|minimal 设置，默认 minimal 以保持 GLM 兼容。
   */
  toolWireFormat?: ToolWireFormat;
  /**
   * 附加到请求 body 的额外参数。
   * 例如 ZhipuAI 关闭思考：{ enable_thinking: false }
   */
  extraBody?: Record<string, unknown>;
}): LLMAdapter {
  const apiKey =
    options?.apiKey ?? readEnvTrimmed('KIMI_API_KEY') ?? readEnvTrimmed('OPENAI_API_KEY') ?? '';
  const baseUrl =
    options?.baseUrl ??
    readEnvTrimmed('KIMI_BASE_URL') ??
    readEnvTrimmed('OPENAI_BASE_URL') ??
    'https://api.openai.com/v1';
  const model =
    options?.model ?? readEnvTrimmed('KIMI_MODEL') ?? readEnvTrimmed('OPENAI_MODEL') ?? 'gpt-4o';
  const extraBody = options?.extraBody ?? {};
  const explicitWire = options?.toolWireFormat ?? (process.env['OPENAI_TOOL_WIRE_FORMAT'] as ToolWireFormat | undefined);
  const toolWireFormat: ToolWireFormat =
    explicitWire ??
    (baseUrl.includes('moonshot') || baseUrl.includes('openai.com') ? 'openai' : 'minimal');
  if (process.env['DEBUG_LLM'] === '1') {
    console.warn('[DEBUG_LLM] adapter toolWireFormat=', toolWireFormat, 'baseUrl=', baseUrl);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  /** 请求中是否包含 user 消息的 image_url block（用于 400 时决定是否用纯文本重试） */
  function hasImageInMessages(messages: Message[]): boolean {
    return messages.some((m) => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      return (m.content as ContentBlock[]).some((b) => b.type === 'image_url');
    });
  }

  /** 将 user 消息中的 ContentBlock[] 压成纯文本（image_url → [图片]），用于接口不支持多模态时的降级重试 */
  function flattenUserContentToText(messages: Message[]): Message[] {
    return messages.map((m) => {
      if (m.role !== 'user' || typeof m.content === 'string') return m;
      const blocks = m.content as ContentBlock[];
      const text = blocks
        .map((b) => (b.type === 'text' ? b.text : '[图片]'))
        .join('\n');
      return { ...m, content: text };
    });
  }

  /**
   * 按 toolWireFormat 序列化消息：
   * - openai: assistant 带 tool_calls，tool 带 tool_call_id（OpenAI/Kimi 要求）
   * - minimal: assistant 仅 content（兼容 GLM），tool 仍带 tool_call_id
   * 部分 API（如 Kimi）要求 assistant 有 tool_calls 时 content 为 null。
   */
  function normalizeMessages(messages: Message[]): object[] {
    return messages.map((m) => {
      let content: string | null;
      if (m.role === 'user') {
        return m;
      }
      if (typeof m.content === 'string') {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        content = (m.content as import('./index.js').ContentBlock[])
          .map((b) => (b.type === 'text' ? b.text : '[image]'))
          .join('\n');
      } else {
        content = '';
      }
      const out: Record<string, unknown> = { role: m.role, content };
      if (m.role === 'assistant' && m.tool_calls?.length && toolWireFormat === 'openai') {
        out['content'] = content || null;
        out['tool_calls'] = m.tool_calls;
        if (process.env['DEBUG_LLM'] === '1') {
          console.warn('[DEBUG_LLM] sending assistant with tool_calls ids:', m.tool_calls.map((t) => t.id));
        }
      }
      if (m.role === 'tool' && m.tool_call_id) out['tool_call_id'] = m.tool_call_id;
      return out;
    });
  }

  function buildBody(
    systemPrompt: string,
    messages: Message[],
    tools?: object[],
    stream = false
  ): string {
    const normalized = normalizeMessages(messages);
    const body: Record<string, unknown> = {
      model,
      stream,
      ...extraBody,
      messages: [
        { role: 'system', content: systemPrompt },
        ...normalized,
      ],
    };
    if (tools && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }
    if (stream && process.env['LLM_STREAM_INCLUDE_USAGE'] !== '0') {
      body['stream_options'] = { include_usage: true };
    }
    if (baseUrl.includes('moonshot') && body['thinking'] === undefined) {
      body['thinking'] = { type: 'disabled' };
    }
    return JSON.stringify(body);
  }

  function recordInnerPiMonoUsage(
    streamUsage: OAIStreamChunk['usage'] | undefined,
    opts: { ok: boolean; durationMs: number },
  ): void {
    recordLlmUsageFromResponse(
      streamUsage ? { usage: streamUsage, model } : { model },
      {
        source: 'inner_pi_mono',
        model,
        provider: 'openai_compat',
        workspaceId: process.env['INNER_WORKSPACE_ID']?.trim() || undefined,
        instanceId: process.env['INNER_INSTANCE_ID']?.trim() || undefined,
      },
      { ok: opts.ok, durationMs: opts.durationMs, recordWithoutUsage: !streamUsage },
    );
  }

  /**
   * 流式 chat/completions：不限制「整段响应」总时长，仅限制相邻两次收到数据的最大间隔（见 LLM_STREAM_IDLE_MS）。
   */
  async function aggregateChatCompletionsStream(
    systemPrompt: string,
    messages: Message[],
    tools: object[] | undefined,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMResult> {
    beginLlmCall();
    const startMs = Date.now();
    let streamUsage: OAIStreamChunk['usage'];
    try {
      const res = await fetchWithRetry(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: buildBody(systemPrompt, messages, tools, true),
        },
        'chat-stream',
      );
      if (!res.body) throw new Error('No response body for streaming');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let fullContent = '';
      const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await readNextStreamChunk(reader, LLM_STREAM_IDLE_MS);
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const json = trimmed.slice(5).trim();
          if (json === '[DONE]') {
            onChunk?.({ delta: '', done: true });
            continue;
          }
          try {
            const chunk = JSON.parse(json) as OAIStreamChunk;
            if (chunk.usage) streamUsage = chunk.usage;
            const choice = chunk.choices[0];
            if (!choice) continue;

            const delta = choice.delta;

            if (delta.content) {
              fullContent += delta.content;
              onChunk?.({ delta: delta.content, done: false });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallAccum.get(tc.index) ?? { id: '', name: '', args: '' };
                if (tc.id) existing.id = tc.id;
                existing.name += tc.function.name ?? '';
                existing.args += tc.function.arguments ?? '';
                toolCallAccum.set(tc.index, existing);
              }
            }
          } catch { /* malformed JSON chunk — skip */ }
        }
      }

      if (process.env['DEBUG_LLM'] === '1' && toolCallAccum.size > 0) {
        console.warn('[DEBUG_LLM] stream tool_calls:', [...toolCallAccum.entries()]);
      }

      const toolCalls = [...toolCallAccum.values()].map((tc, idx) => {
        const rawId = tc.id?.trim();
        const id = rawId || `call_${Math.random().toString(36).slice(2)}`;
        if (!rawId && process.env['DEBUG_LLM'] === '1') {
          console.warn('[DEBUG_LLM] stream tool_calls[' + idx + '] had no id, using fallback:', id);
        }
        return {
          id,
          name: tc.name,
          args: (() => {
            try {
              return JSON.parse(tc.args) as Record<string, unknown>;
            } catch {
              return {} as Record<string, unknown>;
            }
          })(),
        };
      });

      recordInnerPiMonoUsage(streamUsage, { ok: true, durationMs: Date.now() - startMs });
      return { content: fullContent, toolCalls };
    } catch (e) {
      recordInnerPiMonoUsage(streamUsage, { ok: false, durationMs: Date.now() - startMs });
      throw e;
    } finally {
      endLlmCall();
    }
  }

  async function chat(
    systemPrompt: string,
    messages: Message[],
    tools?: object[],
  ): Promise<LLMResult> {
    try {
      return await aggregateChatCompletionsStream(systemPrompt, messages, tools, undefined);
    } catch (e) {
      const errMsg = String(e);
      if (
        !errMsg.includes('400') ||
        (!errMsg.includes('1210') && !errMsg.includes('参数有误')) ||
        !hasImageInMessages(messages)
      ) {
        throw e;
      }
      return aggregateChatCompletionsStream(systemPrompt, flattenUserContentToText(messages), tools, undefined);
    }
  }

  // ── Streaming chat (SSE)，可选 onChunk；与 chat() 同源，仅多回调 ─────────────
  async function stream(
    systemPrompt: string,
    messages: Message[],
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<LLMResult> {
    return aggregateChatCompletionsStream(systemPrompt, messages, undefined, onChunk);
  }

  return { chat, stream };
}

function readEnvTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}
