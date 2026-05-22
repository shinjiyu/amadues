import { createOpenAIAdapter, type ToolWireFormat } from './openai.js';

function readEnvTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** 若未带 `/v1` 等版本路径，则补上 OpenAI-compatible 默认后缀 */
export function normalizeLocalModuleBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/$/, '');
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

/**
 * LocalModule：PocketCity 等 OpenAI Chat Completions 兼容网关。
 * 模型名由 `LOCALMODULE_MODEL` 配置（如 GLM-5.1-FP8、DeepSeek-V4-Pro）。
 */
export function createLocalModuleAdapter(options?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  toolWireFormat?: ToolWireFormat;
  extraBody?: Record<string, unknown>;
}) {
  const apiKey = options?.apiKey ?? readEnvTrimmed('LOCALMODULE_API_KEY') ?? '';
  const baseUrl = normalizeLocalModuleBaseUrl(
    options?.baseUrl ?? readEnvTrimmed('LOCALMODULE_BASE_URL') ?? 'https://ai.pocketcity.com',
  );
  const model =
    options?.model ?? readEnvTrimmed('LOCALMODULE_MODEL') ?? 'GLM-5.1-FP8';
  const toolWireFormat =
    options?.toolWireFormat ??
    (readEnvTrimmed('LOCALMODULE_TOOL_WIRE_FORMAT') as ToolWireFormat | undefined) ??
    'openai';

  return createOpenAIAdapter({
    apiKey,
    baseUrl,
    model,
    toolWireFormat,
    extraBody: options?.extraBody ?? {},
  });
}
