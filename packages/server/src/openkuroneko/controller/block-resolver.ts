/**
 * block-resolver — 方案 C
 * 当 BLOCKED 状态下收到外脑 input 时，
 * 调用 LLM 判断外脑的回复是「提供了资源可 CONTINUE」还是「需要 REPLAN」。
 */

import type { LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';

const RESOLVER_SYSTEM =
  '你是一个决策助手。根据以下信息，判断 Agent 是否应该：\n' +
  '  CONTINUE — 外脑提供了足够的资源/信息，可以继续执行当前里程碑\n' +
  '  REPLAN   — 外脑的回复改变了方向或情况，需要重新规划里程碑\n\n' +
  '只输出一行，格式为：DECISION: <CONTINUE|REPLAN>';

export type BlockDecision = 'CONTINUE' | 'REPLAN';

export async function resolveBlock(
  blockedReason: string,
  externalInput: string,
  llm: LLMAdapter,
  logger: Logger,
): Promise<BlockDecision> {
  const userMessage =
    `BLOCK 原因：${blockedReason}\n\n外脑回复：${externalInput}`;

  logger.info('block-resolver', {
    event: 'resolve.start',
    data: { blockedReason: blockedReason.slice(0, 100), inputPreview: externalInput.slice(0, 80) },
  });

  try {
    const result = await llm.chat(RESOLVER_SYSTEM, [{ role: 'user', content: userMessage }], []);
    const text = result.content ?? '';
    const match = text.match(/DECISION:\s*(CONTINUE|REPLAN)/i);
    const decision = (match && match[1] ? match[1].toUpperCase() : 'REPLAN') as BlockDecision;
    logger.info('block-resolver', { event: 'resolve.done', data: { decision } });
    return decision;
  } catch (e) {
    logger.warn('block-resolver', { event: 'resolve.error', data: { error: String(e) } });
    // 失败时保守选择 REPLAN，触发重规划
    return 'REPLAN';
  }
}
