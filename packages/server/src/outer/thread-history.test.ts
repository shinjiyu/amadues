import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IdentityRegistry, MessageRecordSchema } from '@utlra/chat-ir';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { formatRecentThreadMessagesForLlm } from './thread-history.js';

describe('formatRecentThreadMessagesForLlm', () => {
  it('formats recent messages and detects last speaker / human presence', () => {
    const root = createTestDataRoot('thread-hist-');
    const identityFile = path.join(root.dataRoot, 'identities.json');
    const registry = new IdentityRegistry(identityFile);
    registry.upsert({ sid: 'human:u1', display_name: 'Alice', kind: 'human' });
    registry.upsert({ sid: 'agent:bot', display_name: 'Bot', kind: 'agent' });

    const threadId = 'webchat:global';
    const humanMsg = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: 'msg:1',
      thread_id: threadId,
      sender_sid: 'human:u1',
      sent_at: '2026-05-29T10:00:00.000Z',
      parts: [{ type: 'text', text: '你在看什么？' }],
    });
    const agentMsg = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: 'msg:2',
      thread_id: threadId,
      sender_sid: 'agent:bot',
      sent_at: '2026-05-29T10:01:00.000Z',
      parts: [{ type: 'text', text: '在看日志。' }],
    });

    const loadThreads = () => ({
      threads: [],
      messages: { [threadId]: [humanMsg, agentMsg] },
    });

    const result = formatRecentThreadMessagesForLlm(threadId, loadThreads, registry);
    expect(result.messageCount).toBe(2);
    expect(result.hasHumanMessage).toBe(true);
    expect(result.lastSenderSid).toBe('agent:bot');
    expect(result.text).toContain('你在看什么？');
    expect(result.text).toContain('在看日志。');

    root.cleanup();
  });
});
