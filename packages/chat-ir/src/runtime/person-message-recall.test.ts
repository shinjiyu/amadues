/**
 * ADL: personMessageRecall · P3 按人跨会话记忆召回
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.5
 */
import { describe, expect, it } from 'vitest';
import { IdentityBindingIndex } from './identity-binding-index.js';
import { personSidAliases, recallPersonMessages } from './person-message-recall.js';
import type { LooseThreadStore } from '../thread-store.js';

function msg(threadId: string, senderSid: string, text: string, sentAt: string, id?: string) {
  return {
    schema: 'message.v1',
    message_id: id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    thread_id: threadId,
    sender_sid: senderSid,
    sent_at: sentAt,
    parts: [{ type: 'text', text }],
  };
}

function thread(threadId: string, channel: string, kind: 'dm' | 'group', title?: string) {
  return {
    schema: 'thread.v1',
    thread_id: threadId,
    tenant_id: 'default',
    channel,
    kind,
    ...(title ? { title } : {}),
    participant_sids: [],
    created_at: '2026-07-01T00:00:00.000Z',
  };
}

describe('personSidAliases', () => {
  it('无 index → 只有本 sid', () => {
    expect([...personSidAliases(null, 'idp:user:a')]).toEqual(['idp:user:a']);
  });

  it('canonical sid + 全部 channel_key 的 provisional 形态（含 feishu scoped key 折叠）', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    idx.bind({ channel: 'webchat', native_user_id: 'alice' }, 'idp:user:alice');
    idx.bind({ channel: 'feishu', native_user_id: 'on_a', scope: 'cli_1' }, 'idp:user:alice');

    const aliases = personSidAliases(idx, 'idp:user:alice');
    expect(aliases.has('idp:user:alice')).toBe(true);
    expect(aliases.has('webchat:user:alice')).toBe(true);
    // 历史消息落库时可能带 provisional `feishu:user:on_a`（scope 不进 sid）
    expect(aliases.has('feishu:user:on_a')).toBe(true);
  });
});

describe('recallPersonMessages', () => {
  const store: LooseThreadStore = {
    threads: [
      thread('t:web-dm', 'webchat', 'dm'),
      thread('t:feishu-group', 'feishu', 'group', '项目群'),
      thread('t:other', 'webchat', 'group'),
    ],
    messages: {
      't:web-dm': [
        msg('t:web-dm', 'webchat:user:alice', '私聊里说过 A', '2026-07-20T10:00:00.000Z'),
        msg('t:web-dm', 'idp:agent:shiro', 'agent 回复', '2026-07-20T10:01:00.000Z'),
      ],
      't:feishu-group': [
        msg('t:feishu-group', 'feishu:user:on_a', '群里说过 B', '2026-07-21T09:00:00.000Z'),
        msg('t:feishu-group', 'feishu:user:on_stranger', '别人说的', '2026-07-21T09:05:00.000Z'),
      ],
      't:other': [msg('t:other', 'webchat:user:bob', '无关的人', '2026-07-21T08:00:00.000Z')],
    },
  };

  function linkedIndex(): IdentityBindingIndex {
    const idx = new IdentityBindingIndex({ persistPath: null });
    idx.bind({ channel: 'webchat', native_user_id: 'alice' }, 'idp:user:alice');
    idx.bind({ channel: 'feishu', native_user_id: 'on_a', scope: 'cli_1' }, 'idp:user:alice');
    return idx;
  }

  it('跨渠道合并后：私聊+群聊发言进入同一记忆源，排除当前 thread，附 thread 元数据', () => {
    const hits = recallPersonMessages(store, 'idp:user:alice', {
      index: linkedIndex(),
      excludeThreadId: 't:web-dm',
    });
    // 只剩群里那条（web-dm 被排除；stranger/bob/agent 不算）
    expect(hits).toHaveLength(1);
    expect(hits[0]!.threadId).toBe('t:feishu-group');
    expect(hits[0]!.thread?.title).toBe('项目群');
    expect(hits[0]!.thread?.kind).toBe('group');
    const text = hits[0]!.message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    expect(text).toBe('群里说过 B');
  });

  it('不排除时按 sent_at 新→旧排序，且尊重总量上限', () => {
    const hits = recallPersonMessages(store, 'idp:user:alice', {
      index: linkedIndex(),
      maxMessages: 1,
    });
    expect(hits).toHaveLength(1);
    // 最新的一条是群里 09:00 的
    expect(hits[0]!.threadId).toBe('t:feishu-group');
  });

  it('无 index 时退化为精确 sid 匹配', () => {
    const hits = recallPersonMessages(store, 'webchat:user:alice', {});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.threadId).toBe('t:web-dm');
  });

  it('单 thread 上限生效', () => {
    const many: LooseThreadStore = {
      threads: [thread('t:a', 'webchat', 'group')],
      messages: {
        't:a': Array.from({ length: 10 }, (_, i) =>
          msg('t:a', 'webchat:user:alice', `msg${i}`, `2026-07-21T0${i % 10}:00:00.000Z`),
        ),
      },
    };
    const hits = recallPersonMessages(many, 'webchat:user:alice', { maxPerThread: 3 });
    expect(hits).toHaveLength(3);
  });
});
