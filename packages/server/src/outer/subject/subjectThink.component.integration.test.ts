import { describe, expect, it } from 'vitest';

import { FakeImChannel } from '../../testing/fake-im-channel.js';
import { createTestDataRoot } from '../../testing/temp-data-root.js';
import { runSubjectThink } from './think.js';

/**
 * Component boundary: subjectThink posts through the channel and does not
 * enter the retired conversation loop (that module is not imported here).
 */
describe('component: subjectThink', () => {
  it('SPEAK no_reply posts exactly one status line and zero speech', async () => {
    const root = createTestDataRoot('subject-component-');
    const im = new FakeImChannel();
    const result = await runSubjectThink({
      dataRoot: root.dataRoot,
      nowMs: Date.parse('2026-10-12T00:00:00.000Z'),
      trigger: 'inbound',
      agentSid: 'agent:component',
      imClient: im,
      signals: [{
        source: 'human:owner',
        kind: 'message',
        raw: '主人也只是信号',
        threadId: 'thread:dm:owner',
        messageId: 'm-owner',
      }],
      callLlm: async (_system, user) => user.includes('[TASK:EVALUATE]')
        ? '{"scores":[{"action":"no_reply","score":1},{"action":"defer","score":0},{"action":"do_nothing","score":0}]}'
        : '{"candidates":[{"action":"no_reply","args":{"text":"必须回复"}}]}',
    });
    expect(result.action).toBe('no_reply');
    expect(result.speechPosted).toBe(false);
    const speech = im.outbox.filter((row) => row.body.disposition !== 'status');
    const status = im.outbox.filter((row) => row.body.disposition === 'status');
    expect(speech).toHaveLength(0);
    expect(status).toHaveLength(1);
    expect(status[0]?.body.text).toBe('〔状态〕看到了，这轮不聊。');
    expect(status[0]?.body.parse_mentions).toBe(false);
    expect(status[0]?.body.text).not.toContain('必须回复');
    expect(status[0]?.body.text).not.toContain('不允许静默结束');
    root.cleanup();
  });

  it('heartbeat wait with no human message posts nothing', async () => {
    const root = createTestDataRoot('subject-component-wait-');
    const im = new FakeImChannel();
    const result = await runSubjectThink({
      dataRoot: root.dataRoot,
      nowMs: Date.parse('2026-10-12T00:00:00.000Z'),
      trigger: 'heartbeat_tail',
      agentSid: 'agent:component',
      imClient: im,
    });
    expect(result.thought).toBe(false);
    expect(im.outbox).toHaveLength(0);
    root.cleanup();
  });
});
