/**
 * ADL component: outerConversationLoop — 配置加载契约
 */
import { describe, expect, it } from 'vitest';

import { loadConversationLoopConfigFromEnv } from './outer-conversation-loop.js';

describe('component: outerConversationLoop', () => {
  it('loadConversationLoopConfigFromEnv 默认值（主路径）', () => {
    const cfg = loadConversationLoopConfigFromEnv({});
    expect(cfg.agentName).toBe('Kuroneko');
    expect(cfg.maxTokens).toBeGreaterThan(0);
  });

  it('UTLRA_AGENT_NAME 覆盖 agentName', () => {
    const cfg = loadConversationLoopConfigFromEnv({ UTLRA_AGENT_NAME: 'TestBot' });
    expect(cfg.agentName).toBe('TestBot');
  });
});
