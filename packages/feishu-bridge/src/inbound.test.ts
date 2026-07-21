import { describe, expect, it } from 'vitest';
import {
  IdentityBindingIndex,
  IdentityRegistry,
  type ChatIRInboundMessage,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import { handleFeishuInbound, type FeishuInboundDeps, type FeishuInboundEvent } from './inbound.js';

const AGENT_SID = 'idp:agent:kuro';
const BOT_OPEN_ID = 'ou_bot';

function makeDeps(overrides: Partial<FeishuInboundDeps> = {}) {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const persisted: Array<{
    threadId: string;
    senderSid: string;
    message: ChatIRInboundMessage;
    participantSids: string[];
  }> = [];
  const deps: FeishuInboundDeps = {
    appId: 'cli_a',
    tenant: 'default',
    agentSid: AGENT_SID,
    botOpenId: BOT_OPEN_ID,
    registry: new IdentityRegistry(null),
    bindingIndex: new IdentityBindingIndex(),
    loadThreads: () => store,
    saveThreads: () => {},
    seenEventIds: new Set(),
    lastHumanMessageId: new Map(),
    onMessagePersisted: async (ev) => {
      persisted.push(ev);
    },
    ...overrides,
  };
  return { deps, store, persisted };
}

function textEvent(over: {
  text: string;
  eventId?: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  sender?: { open_id?: string; union_id?: string; user_id?: string };
  mentions?: FeishuInboundEvent['message']['mentions'];
  parentId?: string;
}): FeishuInboundEvent {
  return {
    ...(over.eventId ? { event_id: over.eventId } : {}),
    sender: { sender_id: over.sender ?? { open_id: 'ou_alice', union_id: 'on_alice' } },
    message: {
      message_id: over.messageId ?? 'om_1',
      chat_id: over.chatId ?? 'oc_room',
      chat_type: over.chatType ?? 'group',
      message_type: 'text',
      content: JSON.stringify({ text: over.text }),
      ...(over.parentId ? { parent_id: over.parentId } : {}),
      ...(over.mentions ? { mentions: over.mentions } : {}),
    },
  };
}

describe('handleFeishuInbound', () => {
  it('text 事件 → thread + message 落库，sender 以 union_id 为稳定键', async () => {
    const { deps, store, persisted } = makeDeps();
    const ok = await handleFeishuInbound(deps, textEvent({ text: '你好' }));
    expect(ok).toBe(true);
    expect(store.threads).toHaveLength(1);
    const thread = store.threads[0] as { thread_id: string; kind: string; channel: string };
    expect(thread.thread_id).toBe('feishu:cli_a:chat:oc_room');
    expect(thread.channel).toBe('feishu');
    expect(thread.kind).toBe('group');
    expect(persisted).toHaveLength(1);
    // union_id 优先：sid 与 open_id 无关
    expect(persisted[0]!.senderSid).toBe('feishu:user:on_alice');
    expect(persisted[0]!.message.parts).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('channel_key 带 scope=app_id：换 app 后 open_id 不同也归并到同一 sid（union_id 相同）', async () => {
    const index = new IdentityBindingIndex();
    const a = makeDeps({ bindingIndex: index, appId: 'cli_a' });
    await handleFeishuInbound(a.deps, textEvent({ text: 'hi', sender: { open_id: 'ou_x1', union_id: 'on_same' } }));
    const b = makeDeps({ bindingIndex: index, appId: 'cli_b' });
    await handleFeishuInbound(b.deps, textEvent({ text: 'hi2', sender: { open_id: 'ou_x2', union_id: 'on_same' } }));
    expect(a.persisted[0]!.senderSid).toBe(b.persisted[0]!.senderSid);
    // 两个 app 是两个不同的 channel_key（scope 不同），但 bind 到同一 sid
    expect(index.resolve({ channel: 'feishu', native_user_id: 'on_same', scope: 'cli_a' })).toBe(
      index.resolve({ channel: 'feishu', native_user_id: 'on_same', scope: 'cli_b' }),
    );
  });

  it('bindingIndex 已 linkMerge 到 canonical sid 时，入站用 canonical', async () => {
    const index = new IdentityBindingIndex();
    index.bind({ channel: 'feishu', native_user_id: 'on_alice', scope: 'cli_a' }, 'idp:user:CANON1');
    const { deps, persisted } = makeDeps({ bindingIndex: index });
    await handleFeishuInbound(deps, textEvent({ text: 'yo' }));
    expect(persisted[0]!.senderSid).toBe('idp:user:CANON1');
  });

  it('p2p → dm；bot 自己的消息被回声过滤', async () => {
    const { deps, store, persisted } = makeDeps();
    await handleFeishuInbound(deps, textEvent({ text: 'dm', chatType: 'p2p', chatId: 'oc_dm' }));
    expect((store.threads[0] as { kind: string }).kind).toBe('dm');

    const echo = await handleFeishuInbound(
      deps,
      textEvent({ text: 'echo', messageId: 'om_echo', sender: { open_id: BOT_OPEN_ID } }),
    );
    expect(echo).toBe(false);
    expect(persisted).toHaveLength(1);
  });

  it('event_id 去重：同一事件只处理一次', async () => {
    const { deps, persisted } = makeDeps();
    const ev = textEvent({ text: 'dup', eventId: 'evt-1' });
    expect(await handleFeishuInbound(deps, ev)).toBe(true);
    expect(await handleFeishuInbound(deps, ev)).toBe(false);
    expect(persisted).toHaveLength(1);
  });

  it('@_user_N 占位替换为 mention part；@bot → agentSid', async () => {
    const { deps, persisted } = makeDeps();
    await handleFeishuInbound(
      deps,
      textEvent({
        text: '@_user_1 看下 @_user_2 的方案',
        mentions: [
          { key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Kuro' },
          { key: '@_user_2', id: { open_id: 'ou_bob', union_id: 'on_bob' }, name: 'Bob' },
        ],
      }),
    );
    expect(persisted[0]!.message.parts).toEqual([
      { type: 'mention', target_sid: AGENT_SID, label: 'Kuro' },
      { type: 'text', text: ' 看下 ' },
      { type: 'mention', target_sid: 'feishu:user:on_bob', label: 'Bob' },
      { type: 'text', text: ' 的方案' },
    ]);
  });

  it('parent_id → reply_to_message_id（IR 形态）；记录 lastHumanMessageId', async () => {
    const { deps, persisted } = makeDeps();
    await handleFeishuInbound(deps, textEvent({ text: 're', messageId: 'om_2', parentId: 'om_1' }));
    const msg = persisted[0]!.message as { reply_to_message_id?: string };
    expect(msg.reply_to_message_id).toBe('feishu:cli_a:msg:om_1');
    expect(deps.lastHumanMessageId.get('feishu:cli_a:chat:oc_room')).toBe('om_2');
  });

  it('非 text 类型降级为占位文本，不丢消息', async () => {
    const { deps, persisted } = makeDeps();
    const ev: FeishuInboundEvent = {
      sender: { sender_id: { open_id: 'ou_alice', union_id: 'on_alice' } },
      message: {
        message_id: 'om_img',
        chat_id: 'oc_room',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v2_xxx' }),
      },
    };
    await handleFeishuInbound(deps, ev);
    const part = persisted[0]!.message.parts[0] as { type: string; text: string };
    expect(part.type).toBe('text');
    expect(part.text).toContain('image');
  });
});
