import { zhipuChatCompletion } from '../../zhipu/client.js';
import type { LlmChatOptions, LlmChatResult } from '../types.js';

/**
 * 智谱 provider：复用现有 `zhipuChatCompletion()` 实现。
 * 这层的意义不是重写协议，而是把 provider 选择从调用方抽离。
 */
export async function zhipuProviderChatCompletion(
  opts: Omit<LlmChatOptions, 'provider'>,
): Promise<LlmChatResult> {
  return zhipuChatCompletion(opts);
}
