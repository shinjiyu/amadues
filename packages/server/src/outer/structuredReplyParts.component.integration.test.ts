/**
 * ADL component: structuredReplyParts — structuredReply → MessagePart
 */
import { describe, expect, it } from 'vitest';
import { structuredReplyToMessageParts } from './structured-reply-parts.js';

describe('component: structuredReplyParts', () => {
  it('text-only reply → single text part', () => {
    const parts = structuredReplyToMessageParts({ text: '  你好  ', mention_sids: [] });
    expect(parts).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('blank text with no parts → empty', () => {
    const parts = structuredReplyToMessageParts({ text: '   ', mention_sids: [] });
    expect(parts).toEqual([]);
  });
});
