import { describe, expect, it, vi } from 'vitest';
import {
  ChatIRSeenTracker,
  IdentityRegistry,
  type ChatIRInboundEvent,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import { IlinkApiClient, type WeixinMessage } from './ilink-api-client.js';
import {
  WechatChannel,
  memoryCursorStore,
  renderWechatText,
  type WechatUpdateSource,
} from './wechat-channel.js';

const AGENT_SID = 'idp:agent:kuro';
const BOT_ID = 'e06@im.bot';
const USER_ID = 'alice@im.wechat';
const THREAD_ID = `wechat:${BOT_ID}:dm:${USER_ID}`;

function fakeSource() {
  let handler: ((msgs: WeixinMessage[]) => Promise<void>) | null = null;
  const source: WechatUpdateSource = {
    start(onMessages) {
      handler = onMessages;
    },
    stop: vi.fn(),
  };
  return {
    source,
    emit: (msgs: WeixinMessage[]) => handler!(msgs),
    get started() {
      return handler !== null;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeChannel(over: { onAgentMessage?: (ev: ChatIRInboundEvent) => Promise<void> } = {}) {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const inbound: ChatIRInboundEvent[] = [];
  const apiCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    apiCalls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (url.includes('getconfig')) return jsonResponse({ typing_ticket: 'tk1' });
    return jsonResponse({});
  }) as typeof fetch;
  const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl });
  const src = fakeSource();
  const channel = new WechatChannel({
    config: { botId: BOT_ID, botToken: 'tok' },
    agentSid: AGENT_SID,
    registry: new IdentityRegistry(null),
    loadThreads: () => store,
    saveThreads: () => {},
    seenTracker: new ChatIRSeenTracker({ selfAgentSid: AGENT_SID }),
    onAgentMessage:
      over.onAgentMessage ??
      (async (ev) => {
        inbound.push(ev);
      }),
    updateSource: src.source,
    apiClient: api,
  });
  return { channel, store, inbound, apiCalls, src };
}

function userMsg(over: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: 1,
    from_user_id: USER_ID,
    to_user_id: BOT_ID,
    message_type: 1,
    context_token: 'ctx1',
    item_list: [{ type: 1, text_item: { text: 'hi' } }],
    ...over,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe('WechatChannel', () => {
  it('start → 事件源入站 → onAgentMessage；出站回传 context_token', async () => {
    const { channel, inbound, apiCalls, src } = makeChannel();
    channel.start();
    expect(src.started).toBe(true);

    await src.emit([userMsg()]);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.threadId).toBe(THREAD_ID);

    await channel.postMessage(THREAD_ID, { sender_sid: AGENT_SID, text: '收到' });
    const send = apiCalls.find((c) => c.url.includes('sendmessage'));
    expect(send).toBeTruthy();
    const msg = send!.body['msg'] as Record<string, unknown>;
    expect(msg['to_user_id']).toBe(USER_ID);
    expect(msg['context_token']).toBe('ctx1');
  });

  it('无 context_token（用户没先发言）→ 拒发不炸', async () => {
    const { channel, apiCalls } = makeChannel();
    channel.start();
    await channel.postMessage(THREAD_ID, { sender_sid: AGENT_SID, text: 'x' });
    expect(apiCalls.filter((c) => c.url.includes('sendmessage'))).toHaveLength(0);
  });

  it('非本 bot 的 thread → skip', async () => {
    const { channel, apiCalls, src } = makeChannel();
    channel.start();
    await src.emit([userMsg()]);
    await channel.postMessage(`wechat:other@im.bot:dm:${USER_ID}`, { sender_sid: AGENT_SID, text: 'x' });
    expect(apiCalls.filter((c) => c.url.includes('sendmessage'))).toHaveLength(0);
  });

  it('typing：getconfig 换 ticket + sendtyping；idle 撤销', async () => {
    const { channel, apiCalls, src } = makeChannel();
    channel.start();
    await src.emit([userMsg()]);

    channel.sendActivity(THREAD_ID, 'typing');
    await flush();
    expect(apiCalls.some((c) => c.url.includes('getconfig'))).toBe(true);
    const typingCall = apiCalls.find((c) => c.url.includes('sendtyping'));
    expect(typingCall!.body['status']).toBe(1);

    channel.sendActivity(THREAD_ID, 'idle');
    await flush();
    const last = apiCalls.filter((c) => c.url.includes('sendtyping')).at(-1);
    expect(last!.body['status']).toBe(0);
  });

  it('destroy → 事件源 stop', () => {
    const { channel, src } = makeChannel();
    channel.start();
    channel.destroy();
    expect(src.source.stop).toHaveBeenCalled();
  });
});

describe('renderWechatText', () => {
  it('mention → @label；attachment → 占位', () => {
    expect(
      renderWechatText([
        { type: 'text', text: '你好 ' },
        { type: 'mention', target_sid: 'idp:user:a', label: '张三' },
        { type: 'attachment', asset_ref: { kind: 'file', uri: 'asset:x', name: '报告.pdf' } },
      ]),
    ).toBe('你好 @张三[附件 报告.pdf]');
  });
});

describe('memoryCursorStore', () => {
  it('load/save 往返', () => {
    const c = memoryCursorStore('a');
    expect(c.load()).toBe('a');
    c.save('b');
    expect(c.load()).toBe('b');
  });
});
