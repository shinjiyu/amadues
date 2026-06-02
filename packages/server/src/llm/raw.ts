import { normalizeBaseUrl, type LlmProvider } from './types.js';
import {
  beginLlmCall,
  endLlmCall,
  recordLlmUsageFromResponse,
} from '../outer/llm-usage-tracker.js';
import type { LlmUsageRecordMeta } from '../outer/llm-usage-types.js';
import { parseLlmUsageFromResponse } from '../outer/llm-usage-types.js';

interface RawLlmErrorShape {
  error?: { message?: string; code?: string };
}

export interface LlmRawChatOptions {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  /** Token 统计元数据（source / workspace 等） */
  usageMeta?: Partial<LlmUsageRecordMeta>;
}

export interface LlmRawChatResult<T> {
  raw: T;
  status: number;
}

/**
 * 通用 OpenAI-compatible `chat/completions` 原始调用层。
 *
 * 适用场景：
 * - 需要直接读取 tool_calls
 * - 需要保留 finish_reason / usage / token 等原始字段
 * - 仍希望 provider 特殊逻辑（如 kimi-k2.6 温度约束）集中处理
 */
export async function llmRawChatCompletion<T extends RawLlmErrorShape = RawLlmErrorShape>(
  opts: LlmRawChatOptions,
): Promise<LlmRawChatResult<T>> {
  const body = normalizeProviderRequestBody(opts.provider, opts.body);
  beginLlmCall();
  const startMs = Date.now();
  try {
    const res = await fetch(`${normalizeBaseUrl(opts.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = (await res.json()) as T;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const durationMs = Date.now() - startMs;
    const hasUsage = parseLlmUsageFromResponse(raw) != null;
    recordLlmUsageFromResponse(
      raw,
      {
        source: opts.usageMeta?.source ?? 'unknown',
        model: opts.usageMeta?.model ?? model,
        provider: opts.usageMeta?.provider ?? opts.provider,
        agentId: opts.usageMeta?.agentId,
        workspaceId: opts.usageMeta?.workspaceId,
        instanceId: opts.usageMeta?.instanceId,
        threadId: opts.usageMeta?.threadId,
      },
      { ok: res.ok, durationMs, recordWithoutUsage: !hasUsage },
    );
    if (!res.ok) {
      const msg = raw.error?.message ?? res.statusText;
      throw new Error(`${displayProviderName(opts.provider)} HTTP ${res.status}: ${msg}`);
    }
    return { raw, status: res.status };
  } finally {
    endLlmCall();
  }
}

/**
 * provider 特有的 body 规整：
 * - localmodule（GLM-5.1 fp8 网关）：把 caller 传入的 `thinking: 'enabled' | 'disabled'`
 *   规整成网关接受的 `thinking: { type }`。
 *   历史：曾直接剥离 thinking 字段，导致默认开 thinking 的 GLM 在小 maxTokens
 *   调用下产出空 content；2026-05-17 由 prompt 测试体系上线即捕获，改为透传。
 * - kimi：保留 kimi-k2.6 的温度约束；thinking 在 provider 内部组装，此处不动。
 */
export function normalizeProviderRequestBody(
  provider: LlmProvider,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (provider === 'localmodule') {
    const t = body['thinking'];
    if (t === 'enabled' || t === 'disabled') {
      return { ...body, thinking: { type: t } };
    }
    return body;
  }
  if (provider !== 'kimi') return body;

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (model !== 'kimi-k2.6') return body;

  return {
    ...body,
    // 截至 2026-05，kimi-k2.6 仅接受 temperature=0.6。
    temperature: 0.6,
  };
}

function displayProviderName(provider: LlmProvider): string {
  if (provider === 'kimi') return 'Kimi';
  if (provider === 'localmodule') return 'LocalModule';
  return 'Zhipu';
}
