/**
 * ADL component: outerOrchestrator — structuredReply → MessagePart
 */
import { describe, expect, it } from 'vitest';

import { structuredReplyToMessageParts } from './orchestrator.js';

describe('component: outerOrchestrator', () => {
  it('纯文本 reply → text part（主路径）', () => {
    const parts = structuredReplyToMessageParts({ text: '  你好  ', mention_sids: [] });
    expect(parts).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('空 reply → 空 parts', () => {
    const parts = structuredReplyToMessageParts({ text: '   ', mention_sids: [] });
    expect(parts).toEqual([]);
  });
});
