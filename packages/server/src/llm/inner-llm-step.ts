import type { ChatMessage, LlmEnv, LlmProvider } from './types.js';
import { llmChatCompletion } from './client.js';

export type { LlmEnv as InnerLlmEnv };

export interface InnerLlmStepInput {
  goalMarkdown: string;
  userHint?: string;
  imageBase64?: string;
  imageMime?: string;
}

export interface InnerLlmStepResult {
  assistantText: string;
  usedVision: boolean;
}

const SYS =
  '你是内脑执行助手。根据给定 goal 与补充信息（及附图），输出本轮可执行的结论或下一步计划（Markdown）。' +
  '简洁、可验证；不要编造未提供的信息。';

/**
 * 无图：主文本模型。
 * 有图：visionModel。当前 Kimi 直接走多模态；GLM 保持现有 direct 路径（MCP 特化仍在 adapter/glm.ts）。
 */
export async function runInnerLlmStep(env: LlmEnv, input: InnerLlmStepInput): Promise<InnerLlmStepResult> {
  const goalBlock = '## 当前任务目标（goal）\n' + (input.goalMarkdown.trim() || '（未设置）');
  const hintBlock = input.userHint?.trim()
    ? '\n\n## 用户本轮补充\n' + input.userHint.trim()
    : '';

  if (input.imageBase64?.trim()) {
    const mime = input.imageMime ?? 'image/png';
    const dataUrl = `data:${mime};base64,${input.imageBase64.trim()}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: SYS },
      {
        role: 'user',
        content: [
          { type: 'text', text: goalBlock + hintBlock + '\n\n请结合附图回答。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];
    const { content } = await llmChatCompletion({
      provider: env.provider,
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      model: env.visionModel,
      messages,
      maxTokens: env.maxTokensMultimodal,
      temperature: 0.5,
      thinking: env.thinking,
    });
    return { assistantText: content.trim(), usedVision: true };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYS },
    { role: 'user', content: goalBlock + hintBlock },
  ];
  const { content } = await llmChatCompletion({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    model: env.textModel,
    messages,
    maxTokens: env.maxTokensText,
    temperature: 0.5,
    thinking: env.thinking,
  });
  return { assistantText: content.trim(), usedVision: false };
}

/**
 * 保持现有设计：全链路共用一套主模型配置，只区分 think / no-think。
 *
 * provider 选择：
 * - 若 `UTLRA_INNER_LLM_PROVIDER` 为 `zhipu` | `kimi` | `localmodule` 且对应 Key 已配置，则使用该 provider。
 * - 否则自动：ZHIPU_API_KEY → zhipu；KIMI_API_KEY → kimi；LOCALMODULE_API_KEY → localmodule。
 */
export function loadInnerLlmEnvFromProcess(): LlmEnv | null {
  const provider = resolveProviderFromProcess();
  if (!provider) return null;

  if (provider === 'zhipu') {
    return {
      provider,
      apiKey: readRequiredEnv('ZHIPU_API_KEY'),
      baseUrl: readEnvTrimmed('ZHIPU_BASE_URL') ?? 'https://open.bigmodel.cn/api/coding/paas/v4',
      textModel: readEnvTrimmed('ZHIPU_MODEL') ?? 'glm-5.1',
      visionModel: readEnvTrimmed('ZHIPU_VISION_MODEL') ?? 'glm-5v-turbo',
      maxTokensText: Math.min(65536, Math.max(256, Number(readEnvTrimmed('ZHIPU_MAX_TOKENS') ?? 4096))),
      maxTokensMultimodal: Math.min(
        65536,
        Math.max(512, Number(readEnvTrimmed('ZHIPU_MULTIMODAL_MAX_TOKENS') ?? 8192)),
      ),
      thinking: readEnvTrimmed('ZHIPU_THINKING') === 'enabled' ? 'enabled' : 'disabled',
    };
  }

  if (provider === 'localmodule') {
    const baseRaw = readEnvTrimmed('LOCALMODULE_BASE_URL') ?? 'https://ai.pocketcity.com';
    const baseUrl = normalizeLocalModuleBaseUrl(baseRaw);
    return {
      provider,
      apiKey: readRequiredEnv('LOCALMODULE_API_KEY'),
      baseUrl,
      textModel: readEnvTrimmed('LOCALMODULE_MODEL') ?? 'GLM-5.1-FP8',
      visionModel:
        readEnvTrimmed('LOCALMODULE_VISION_MODEL') ??
        readEnvTrimmed('LOCALMODULE_MODEL') ??
        'GLM-5.1-FP8',
      maxTokensText: Math.min(
        65536,
        Math.max(256, Number(readEnvTrimmed('LOCALMODULE_MAX_TOKENS') ?? 4096)),
      ),
      maxTokensMultimodal: Math.min(
        65536,
        Math.max(512, Number(readEnvTrimmed('LOCALMODULE_MULTIMODAL_MAX_TOKENS') ?? 8192)),
      ),
      thinking: 'disabled',
    };
  }

  return {
    provider: 'kimi',
    apiKey: readRequiredEnv('KIMI_API_KEY'),
    baseUrl: readEnvTrimmed('KIMI_BASE_URL') ?? 'https://api.moonshot.cn/v1',
    textModel: readEnvTrimmed('KIMI_MODEL') ?? 'kimi-k2.6',
    visionModel: readEnvTrimmed('KIMI_VISION_MODEL') ?? readEnvTrimmed('KIMI_MODEL') ?? 'kimi-k2.6',
    maxTokensText: Math.min(65536, Math.max(256, Number(readEnvTrimmed('KIMI_MAX_TOKENS') ?? 4096))),
    maxTokensMultimodal: Math.min(
      65536,
      Math.max(512, Number(readEnvTrimmed('KIMI_MULTIMODAL_MAX_TOKENS') ?? 8192)),
    ),
    thinking: readEnvTrimmed('KIMI_THINKING') === 'enabled' ? 'enabled' : 'disabled',
  };
}

function normalizeLocalModuleBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/$/, '');
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function resolveProviderFromProcess(): LlmProvider | null {
  const wan = readEnvTrimmed('UTLRA_INNER_LLM_PROVIDER')?.toLowerCase();
  if (wan) {
    if (wan === 'localmodule' && readEnvTrimmed('LOCALMODULE_API_KEY')) return 'localmodule';
    if (wan === 'zhipu' && readEnvTrimmed('ZHIPU_API_KEY')) return 'zhipu';
    if (wan === 'kimi' && readEnvTrimmed('KIMI_API_KEY')) return 'kimi';
  }
  if (readEnvTrimmed('ZHIPU_API_KEY')) return 'zhipu';
  if (readEnvTrimmed('KIMI_API_KEY')) return 'kimi';
  if (readEnvTrimmed('LOCALMODULE_API_KEY')) return 'localmodule';
  return null;
}

function readEnvTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function readRequiredEnv(name: string): string {
  const v = readEnvTrimmed(name);
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}
