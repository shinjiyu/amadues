import { describe, expect, it } from 'vitest';
import {
  ChatIRSeenTracker,
  IdentityBindingIndex,
  IdentityRegistry,
  type ChatIRInboundEvent,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import type { FeishuApiClient } from './api-client.js';
import {
  FeishuChannel,
  renderFeishuTextContent,
  type FeishuEventSource,
} from './feishu-channel.js';
import type { FeishuInboundEvent } from './inbound.js';

const AGENT_SID = 'idp:agent:kuro';
const BOT_OPEN_ID = 'ou_bot';

/** 可编程 fake API：记录调用并返回预置值 */
function makeFakeApi() {
  const sent: Array<{ kind: 'send' | 'reply'; target: string; content: string }> = [];
  const reactions: Array<{ op: 'create' | 'delete'; messageId: string; id: string }> = [];
  let reactionSeq = 0;
  const api = {
    probe: async () => {},
    getBotInfo: async () => ({ open_id: BOT_OPEN_ID }),
    sendTextMessage: async (chatId: string, content: string) => {
      sent.push({ kind: 'send', target: chatId, content });
      return { message_id: `om_out_${sent.length}`, chat_id: chatId };
    },
    replyTextMessage: async (parentId: string, content: string) => {
      sent.push({ kind: 'reply', target: parentId, content });
      return { message_id: `om_out_${sent.length}`, chat_id: 'oc_room' };
    },
    createReaction: async (messageId: string) => {
      const id = `r-${++reactionSeq}`;
      reactions.push({ op: 'create', messageId, id });
      return id;
    },
    deleteReaction: async (messageId: string, reactionId: string) => {
      reactions.push({ op: 'delete', messageId, id: reactionId });
    },
  };
  return { api: api as unknown as FeishuApiClient, sent, reactions };
}

function makeFakeEventSource() {
  let handler: ((ev: FeishuInboundEvent) => Promise<void>) | null = null;
  let stopped = false;
  const source: FeishuEventSource = {
    start(onEvent) {
      handler = onEvent;
    },
    stop() {
      stopped = true;
    },
  };
  return {
    source,
    emit: (ev: FeishuInboundEvent) => handler!(ev),
    isStarted: () => handler !== null,
    isStopped: () => stopped,
  };
}

function makeChannel() {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const inbound: ChatIRInboundEvent[] = [];
  const { api, sent, reactions } = makeFakeApi();
  const events = makeFakeEventSource();
  const registry = new IdentityRegistry(null);
  const channel = new FeishuChannel({
    config: { appId: 'cli_a', appSecret: 's', tenant: 'default' },
    botOpenId: BOT_OPEN_ID,
    agentSid: AGENT_SID,
    registry,
    bindingIndex: new IdentityBindingIndex(),
    loadThreads: () => store,
    saveThreads: () => {},
    seenTracker: new ChatIRSeenTracker({ selfAgentSid: AGENT_SID }),
    onAgentMessage: async (ev) => {
      inbound.push(ev);
    },
    eventSource: events.source,
    apiClient: api,
  });
  return { channel, store, inbound, sent, reactions, events, registry };
}

function humanEvent(text: string, messageId = 'om_h1'): FeishuInboundEvent {
  return {
    sender: { sender_id: { open_id: 'ou_alice', union_id: 'on_alice' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_room',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

const THREAD = 'feishu:cli_a:chat:oc_room';

/** sendActivity 内部是 fire-and-forget async；等微任务清空 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FeishuChannel', () => {
  it('start 接上事件源；入站 → onAgentMessage；destroy 停源', async () => {
    const { channel, inbound, events } = makeChannel();
    channel.start();
    expect(events.isStarted()).toBe(true);
    await events.emit(humanEvent('你好'));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.threadId).toBe(THREAD);
    expect(inbound[0]!.senderSid).toBe('feishu:user:on_alice');
    channel.destroy();
    expect(events.isStopped()).toBe(true);
  });

  it('postMessage → 飞书 REST + 落库；非本 app thread 拒发', async () => {
    const { channel, store, sent } = makeChannel();
    channel.start();
    await channel.postMessage(THREAD, { sender_sid: AGENT_SID, text: '收到' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toBe('oc_room');
    expect(JSON.parse(sent[0]!.content)).toEqual({ text: '收到' });
    expect(store.messages[THREAD]).toHaveLength(1);

    await channel.postMessage('feishu:cli_OTHER:chat:oc_room', { sender_sid: AGENT_SID, text: 'x' });
    expect(sent).toHaveLength(1); // 未发出
  });

  it('typing → 对最后一条人类消息打 Typing 表情；idle 撤销；幂等', async () => {
    const { channel, events, reactions } = makeChannel();
    channel.start();
    await events.emit(humanEvent('问个问题', 'om_h9'));

    channel.sendActivity(THREAD, 'typing');
    await flush();
    expect(reactions).toEqual([{ op: 'create', messageId: 'om_h9', id: 'r-1' }]);

    channel.sendActivity(THREAD, 'typing'); // 同一目标消息 → 幂等不重复
    await flush();
    expect(reactions).toHaveLength(1);

    channel.sendActivity(THREAD, 'idle');
    await flush();
    expect(reactions[1]).toEqual({ op: 'delete', messageId: 'om_h9', id: 'r-1' });
  });

  it('postMessage 成功后顺手撤 typing reaction（回复已发出 = 不再打字）', async () => {
    const { channel, events, reactions } = makeChannel();
    channel.start();
    await events.emit(humanEvent('在吗', 'om_h2'));
    channel.sendActivity(THREAD, 'typing');
    await flush();
    await channel.postMessage(THREAD, { sender_sid: AGENT_SID, text: '在' });
    await flush();
    expect(reactions.map((r) => r.op)).toEqual(['create', 'delete']);
  });

  it('无人类消息可作 typing 目标时静默跳过（best-effort）', async () => {
    const { channel, reactions } = makeChannel();
    channel.start();
    channel.sendActivity(THREAD, 'typing');
    await flush();
    expect(reactions).toHaveLength(0);
  });
});

describe('renderFeishuTextContent', () => {
  it('mention part → <at> 标签（open_id 来自 registry bindings）', () => {
    const registry = new IdentityRegistry(null);
    registry.upsert({
      schema: 'identity.v1',
      sid: 'feishu:user:on_bob',
      kind: 'human',
      display_name: 'Bob',
      aliases: [],
      roles_in_tenant: ['member'],
      bindings: [{ channel: 'feishu', native_user_id: 'ou_bob', native_union_id: 'on_bob' }],
      updated_at: new Date().toISOString(),
    });
    const content = renderFeishuTextContent(
      [
        { type: 'mention', target_sid: 'feishu:user:on_bob', label: 'Bob' },
        { type: 'text', text: ' 来看看' },
      ],
      registry,
    );
    expect(JSON.parse(content)).toEqual({ text: '<at user_id="ou_bob">Bob</at> 来看看' });
  });
});
