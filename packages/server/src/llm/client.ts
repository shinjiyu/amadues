import type { LlmChatOptions, LlmChatResult } from './types.js';
import { kimiProviderChatCompletion } from './providers/kimi.js';
import { localmoduleProviderChatCompletion } from './providers/localmodule.js';
import { zhipuProviderChatCompletion } from './providers/zhipu.js';

/**
 * Provider-neutral chat completion dispatch.
 *
 * 当前只收敛 outer / inner-step 侧的 provider 选择；
 * openkuroneko 的 `LLMAdapter` 体系仍保留在 adapter/ 目录下。
 */
export async function llmChatCompletion(opts: LlmChatOptions): Promise<LlmChatResult> {
  switch (opts.provider) {
    case 'zhipu':
      return zhipuProviderChatCompletion(stripProvider(opts));
    case 'kimi':
      return kimiProviderChatCompletion(stripProvider(opts));
    case 'localmodule':
      return localmoduleProviderChatCompletion(stripProvider(opts));
    default: {
      const exhaustive: never = opts.provider;
      throw new Error(`unsupported llm provider: ${String(exhaustive)}`);
    }
  }
}

function stripProvider(opts: LlmChatOptions): Omit<LlmChatOptions, 'provider'> {
  const { provider: _provider, ...rest } = opts;
  return rest;
}
