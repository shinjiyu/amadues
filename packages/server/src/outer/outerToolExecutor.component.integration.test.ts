/**
 * ADL component: outerToolExecutor — 出站 @ 规范化
 */
import { describe, expect, it } from 'vitest';

import { normalizeAgentReplyMentionText } from './outer-tools.js';

describe('component: outerToolExecutor', () => {
  it('[@昵称](@sid:…) → @昵称（主路径）', () => {
    const out = normalizeAgentReplyMentionText('你好 [@Kuro](@sid:agent:kuro) 请查收');
    expect(out).toContain('@Kuro');
    expect(out).not.toContain('@sid:');
  });

  it('纯文本原文保留', () => {
    expect(normalizeAgentReplyMentionText('仅结论')).toBe('仅结论');
  });
});
