/**
 * ADL component: blockResolver — BLOCK + 外脑 input → CONTINUE | REPLAN
 */
import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger/index.js';
import { createFakeLLM } from '../../testing/fake-llm.js';
import { resolveBlock } from './block-resolver.js';

describe('component: blockResolver', () => {
  const logger = createLogger('test-agent', '/tmp');

  it('LLM 返回 CONTINUE → CONTINUE（主路径）', async () => {
    const llm = createFakeLLM([
      { match: '决策助手', reply: { content: 'DECISION: CONTINUE' } },
    ]);
    const d = await resolveBlock('缺 API key', '已提供 key', llm, logger);
    expect(d).toBe('CONTINUE');
  });

  it('LLM 异常 → 保守 REPLAN', async () => {
    const llm = {
      chat: async () => {
        throw new Error('network');
      },
      stream: async function* () {
        yield { type: 'done' as const };
      },
    };
    const d = await resolveBlock('阻塞', '回复', llm, logger);
    expect(d).toBe('REPLAN');
  });
});
