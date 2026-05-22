/**
 * Prompt 测试用：从 `InnerLlmEnv` 构造与生产一致的 `LLMAdapter`。
 */
import {
  createLocalModuleAdapter,
  createOpenAIAdapter,
  type LLMAdapter,
} from '../openkuroneko/adapter/index.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';

/** Prompt 套件：关 thinking、限制 max_tokens，避免 GLM 等模型拖过 vitest 超时。 */
function promptExtraBody(env: InnerLlmEnv): Record<string, unknown> {
  const cap = Math.min(env.maxTokensText ?? 4096, 4096);
  return {
    max_tokens: cap,
    thinking: { type: 'disabled' },
  };
}

export function createLlmAdapterForPrompt(env: InnerLlmEnv): LLMAdapter {
  const extraBody = promptExtraBody(env);
  if (env.provider === 'localmodule') {
    return createLocalModuleAdapter({
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      model: env.textModel,
      extraBody,
    });
  }
  return createOpenAIAdapter({
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    model: env.textModel,
    toolWireFormat: 'minimal',
    extraBody,
  });
}
