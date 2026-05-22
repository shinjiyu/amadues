import { describe, expect, it } from 'vitest';
import { normalizeAgentReplyMentionText } from './outer-tools.js';

describe('normalizeAgentReplyMentionText', () => {
  it('flattens markdown sid link to @display', () => {
    const raw = '长驱直入 [@kuroneko](@sid:idp:agent:discord-bot:1491788580421369987) 接"入"';
    expect(normalizeAgentReplyMentionText(raw)).toBe('长驱直入 @kuroneko 接"入"');
  });

  it('unwraps bold-wrapped markdown sid link', () => {
    const raw =
      '长驱直入 [**[@kuroneko](@sid:idp:agent:discord-bot:1491788580421369987)**] 接"入"';
    expect(normalizeAgentReplyMentionText(raw)).toBe('长驱直入 @kuroneko 接"入"');
  });
});
