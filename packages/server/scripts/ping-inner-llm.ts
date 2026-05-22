/**
 * 连通性检查：读当前进程的 LLM env，发一条最短 chat（不打印任何 key）。
 *
 *   cd packages/server
 *   node --env-file=../../.env --import tsx/esm scripts/ping-inner-llm.ts
 */
import { loadInnerLlmEnvFromProcess } from '../src/llm/inner-llm-step.js';
import { llmChatCompletion } from '../src/llm/client.js';

const env = loadInnerLlmEnvFromProcess();
if (!env) {
  console.error(
    '[ping-inner-llm] loadInnerLlmEnvFromProcess() 为 null。请检查 ZHIPU/KIMI/LOCALMODULE 相关变量。',
  );
  process.exit(1);
}

console.log('[ping-inner-llm] provider=', env.provider, 'textModel=', env.textModel, 'baseUrl=', env.baseUrl);

const { content } = await llmChatCompletion({
  provider: env.provider,
  apiKey: env.apiKey,
  baseUrl: env.baseUrl,
  model: env.textModel,
  messages: [
    { role: 'system', content: 'You are a connectivity probe. Answer as briefly as possible.' },
    { role: 'user', content: 'Reply with exactly one word: PONG' },
  ],
  maxTokens: 32,
  temperature: 0.3,
  thinking: env.thinking,
});

console.log('[ping-inner-llm] assistant=', content.trim().slice(0, 200));
console.log('[ping-inner-llm] done');
