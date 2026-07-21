import { describe, expect, it } from 'vitest';
import {
  IdentityBindingIndex,
  IdentityRegistry,
  type ChatIRInboundMessage,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import type { WeixinMessage } from './ilink-api-client.js';
import { handleWechatInbound, type WechatInboundDeps } from './inbound.js';

const AGENT_SID = 'idp:agent:kuro';
const BOT_ID = 'e06@im.bot';
const USER_ID = 'alice@im.wechat';

function makeDeps(overrides: Partial<WechatInboundDeps> = {}) {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const persisted: Array<{
    threadId: string;
    senderSid: string;
    message: ChatIRInboundMessage;
    participantSids: string[];
  }> = [];
  const contextTokens = new Map<string, string>();
  const deps: WechatInboundDeps = {
    botId: BOT_ID,
    tenant: 'default',
    agentSid: AGENT_SID,
    registry: new IdentityRegistry(null),
    bindingIndex: new IdentityBindingIndex(),
    loadThreads: () => store,
    saveThreads: () => {},
    seenMessageIds: new Set(),
    contextTokens,
    onMessagePersisted: async (ev) => {
      persisted.push(ev);
    },
    ...overrides,
  };
  return { deps, store, persisted, contextTokens };
}

function userMsg(over: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: 429,
    from_user_id: USER_ID,
    to_user_id: BOT_ID,
    message_type: 1,
    message_state: 2,
    create_time_ms: 1774158905123,
    context_token: 'ctx-429',
    item_list: [{ type: 1, text_item: { text: '帮我总结会议' } }],
    ...over,
  };
}

describe('handleWechatInbound', () => {
  it('用户文本 → dm thread + message 落库 + context_token 缓存', async () => {
    const { deps, store, persisted, contextTokens } = makeDeps();
    const ok = await handleWechatInbound(deps, userMsg());
    expect(ok).toBe(true);

    const threadId = `wechat:${BOT_ID}:dm:${USER_ID}`;
    expect(store.threads).toHaveLength(1);
    const thread = store.threads[0] as { thread_id: string; kind: string; channel: string };
    expect(thread.thread_id).toBe(threadId);
    expect(thread.channel).toBe('wechat');
    expect(thread.kind).toBe('dm');

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.senderSid).toBe(`wechat:user:${USER_ID}`);
    expect(persisted[0]!.message.parts).toEqual([{ type: 'text', text: '帮我总结会议' }]);
    expect(contextTokens.get(threadId)).toBe('ctx-429');
  });

  it('bot 回声（message_type=2）跳过', async () => {
    const { deps, persisted } = makeDeps();
    const ok = await handleWechatInbound(deps, userMsg({ message_type: 2, from_user_id: '' }));
    expect(ok).toBe(false);
    expect(persisted).toHaveLength(0);
  });

  it('message_id 去重', async () => {
    const { deps, persisted } = makeDeps();
    await handleWechatInbound(deps, userMsg());
    const again = await handleWechatInbound(deps, userMsg());
    expect(again).toBe(false);
    expect(persisted).toHaveLength(1);
  });

  it('bindingIndex 已确认绑定 → sender 折叠为 canonical sid（scope=bot_id）', async () => {
    const idx = new IdentityBindingIndex();
    idx.bind({ channel: 'wechat', native_user_id: USER_ID, scope: BOT_ID }, 'idp:user:alice');
    const { deps, persisted } = makeDeps({ bindingIndex: idx });
    await handleWechatInbound(deps, userMsg());
    expect(persisted[0]!.senderSid).toBe('idp:user:alice');
  });

  it('媒体消息降级占位文本；context_token 更新为最近一条', async () => {
    const { deps, persisted, contextTokens } = makeDeps();
    await handleWechatInbound(deps, userMsg());
    await handleWechatInbound(
      deps,
      userMsg({ message_id: 430, context_token: 'ctx-430', item_list: [{ type: 2, image_item: {} }] }),
    );
    expect(persisted[1]!.message.parts).toEqual([
      { type: 'text', text: '[微信图片消息，暂未镜像内容]' },
    ]);
    expect(contextTokens.get(`wechat:${BOT_ID}:dm:${USER_ID}`)).toBe('ctx-430');
  });

  it('group_id 存在 → group thread（协议预留）', async () => {
    const { deps, store } = makeDeps();
    await handleWechatInbound(deps, userMsg({ group_id: 'g_1' }));
    const thread = store.threads[0] as { thread_id: string; kind: string };
    expect(thread.thread_id).toBe(`wechat:${BOT_ID}:group:g_1`);
    expect(thread.kind).toBe('group');
  });
});
