import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  type WechatAssetStore,
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

function makeChannel(
  over: {
    onAgentMessage?: (ev: ChatIRInboundEvent) => Promise<void>;
    assetStore?: WechatAssetStore;
  } = {},
) {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const inbound: ChatIRInboundEvent[] = [];
  const apiCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const isJsonBody = typeof init?.body === 'string';
    apiCalls.push({ url, body: isJsonBody ? (JSON.parse(String(init!.body)) as Record<string, unknown>) : {} });
    if (url.includes('getconfig')) return jsonResponse({ typing_ticket: 'tk1' });
    if (url.includes('getuploadurl')) return jsonResponse({ upload_param: 'UP=' });
    if (url.includes('/upload')) {
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'DOWN=' } });
    }
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
    ...(over.assetStore ? { assetStore: over.assetStore } : {}),
  });
  return { channel, store, inbound, apiCalls, src };
}

/** CDN /download 返回给定二进制的变体（入站媒体镜像用） */
function makeChannelWithBinaryCdn(assetStore: WechatAssetStore, cdnBytes: Buffer) {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const inbound: ChatIRInboundEvent[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/download')) return new Response(new Uint8Array(cdnBytes), { status: 200 });
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
    onAgentMessage: async (ev) => {
      inbound.push(ev);
    },
    updateSource: src.source,
    apiClient: api,
    assetStore,
  });
  return { channel, inbound, src };
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

  it('无 context_token（用户没先发言）→ 抛 WechatNoContextTokenError', async () => {
    const { channel, apiCalls } = makeChannel();
    channel.start();
    await expect(
      channel.postMessage(THREAD_ID, { sender_sid: AGENT_SID, text: 'x' }),
    ).rejects.toThrow(/wechat_no_context_token/);
    expect(apiCalls.filter((c) => c.url.includes('sendmessage'))).toHaveLength(0);
  });

  it('context_token 持久化：重启后仍可出站', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-ctx-'));
    const tokenPath = path.join(dir, 'tokens.json');
    try {
      const store: LooseThreadStore = { threads: [], messages: {} };
      const apiCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const isJsonBody = typeof init?.body === 'string';
        apiCalls.push({
          url,
          body: isJsonBody ? (JSON.parse(String(init!.body)) as Record<string, unknown>) : {},
        });
        return jsonResponse({});
      }) as typeof fetch;
      const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl });
      const src = fakeSource();
      const c1 = new WechatChannel({
        config: { botId: BOT_ID, botToken: 'tok' },
        agentSid: AGENT_SID,
        registry: new IdentityRegistry(null),
        loadThreads: () => store,
        saveThreads: () => {},
        seenTracker: new ChatIRSeenTracker({ selfAgentSid: AGENT_SID }),
        onAgentMessage: async () => {},
        updateSource: src.source,
        apiClient: api,
        contextTokenPath: tokenPath,
      });
      c1.start();
      await src.emit([userMsg()]);
      expect(fs.existsSync(tokenPath)).toBe(true);

      const src2 = fakeSource();
      const api2 = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl });
      const c2 = new WechatChannel({
        config: { botId: BOT_ID, botToken: 'tok' },
        agentSid: AGENT_SID,
        registry: new IdentityRegistry(null),
        loadThreads: () => store,
        saveThreads: () => {},
        seenTracker: new ChatIRSeenTracker({ selfAgentSid: AGENT_SID }),
        onAgentMessage: async () => {},
        updateSource: src2.source,
        apiClient: api2,
        contextTokenPath: tokenPath,
      });
      c2.start();
      await c2.postMessage(THREAD_ID, { sender_sid: AGENT_SID, text: 'after-restart' });
      const send = apiCalls.find((c) => c.url.includes('sendmessage'));
      expect(send).toBeTruthy();
      expect((send!.body['msg'] as Record<string, unknown>)['context_token']).toBe('ctx1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    const cfg = apiCalls.find((c) => c.url.includes('getconfig'));
    expect(cfg!.body['ilink_user_id']).toBe(USER_ID);
    const typingCall = apiCalls.find((c) => c.url.includes('sendtyping'));
    expect(typingCall!.body['ilink_user_id']).toBe(USER_ID);
    expect(typingCall!.body['status']).toBe(1);

    channel.sendActivity(THREAD_ID, 'idle');
    await flush();
    const last = apiCalls.filter((c) => c.url.includes('sendtyping')).at(-1);
    expect(last!.body['status']).toBe(2);
  });

  it('出站附件（assetStore）：图片走 upload + type=2；文件走 type=4；文本仍先发', async () => {
    const assetStore: WechatAssetStore = {
      save: () => ({ id: 'x' }),
      get: (id) =>
        id === 'img-1'
          ? { meta: { mime: 'image/png', name: 'qr.png' }, buffer: Buffer.from([0x89, 0x50]) }
          : { meta: { mime: 'text/markdown', name: 'ch11.md' }, buffer: Buffer.from('# ch11') },
    };
    const { channel, apiCalls, src } = makeChannel({ assetStore });
    channel.start();
    await src.emit([userMsg()]);

    await channel.postMessage(THREAD_ID, {
      sender_sid: AGENT_SID,
      text: '给你',
      parts: [
        { type: 'text', text: '给你' },
        { type: 'attachment', asset_ref: { kind: 'image', uri: 'asset:img-1', mime: 'image/png', name: 'qr.png' } },
        { type: 'attachment', asset_ref: { kind: 'file', uri: 'asset:file-1', mime: 'text/markdown', name: 'ch11.md' } },
      ],
    });

    const sends = apiCalls.filter((c) => c.url.includes('sendmessage'));
    expect(sends).toHaveLength(3);
    const items = sends.map(
      (s) => ((s.body['msg'] as Record<string, unknown>)['item_list'] as Array<Record<string, unknown>>)[0]!,
    );
    expect(items[0]!['type']).toBe(1); // 文本
    expect(items[1]!['type']).toBe(2); // 图片
    expect(items[2]!['type']).toBe(4); // 文件
    expect((items[2]!['file_item'] as Record<string, unknown>)['file_name']).toBe('ch11.md');
    // 两次媒体上传
    expect(apiCalls.filter((c) => c.url.includes('getuploadurl'))).toHaveLength(2);
    expect(apiCalls.filter((c) => c.url.includes('/upload?'))).toHaveLength(2);
  });

  it('出站附件上传失败 → 降级防链接化文本通知', async () => {
    const assetStore: WechatAssetStore = {
      save: () => ({ id: 'x' }),
      get: () => null, // asset 缺失 → sendAttachment 抛错走降级
    };
    const { channel, apiCalls, src } = makeChannel({ assetStore });
    channel.start();
    await src.emit([userMsg()]);

    await channel.postMessage(THREAD_ID, {
      sender_sid: AGENT_SID,
      text: '',
      parts: [
        { type: 'attachment', asset_ref: { kind: 'file', uri: 'asset:gone', mime: 'text/markdown', name: 'ch11.md' } },
      ],
    });
    const sends = apiCalls.filter((c) => c.url.includes('sendmessage'));
    expect(sends).toHaveLength(1);
    const item = ((sends[0]!.body['msg'] as Record<string, unknown>)['item_list'] as Array<Record<string, unknown>>)[0]!;
    const text = (item['text_item'] as { text: string }).text;
    expect(text).toContain('发送失败');
    expect(text).not.toContain('ch11.md'); // 文件名已防链接化
  });

  it('入站图片（assetStore）→ 镜像为 attachment part', async () => {
    const savedBufs: Buffer[] = [];
    const assetStore: WechatAssetStore = {
      save: (buf) => {
        savedBufs.push(buf);
        return { id: '11111111-2222-4333-8444-555555555555' };
      },
      get: () => null,
    };
    // 密文 = AES(jpeg bytes)；fetchImpl 需要返回二进制 → 单独造 channel 不方便，这里直接注入无加密 CDN 响应：
    // downloadMedia 无 key 时按明文返回
    const { channel, inbound, src } = makeChannelWithBinaryCdn(assetStore, Buffer.from([0xff, 0xd8, 0xff, 1]));
    channel.start();
    await src.emit([
      userMsg({
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'Q=' } } }],
      }),
    ]);
    expect(savedBufs).toHaveLength(1);
    const parts = inbound[0]!.message.parts as Array<Record<string, unknown>>;
    expect((parts[0] as { asset_ref: { mime: string } }).asset_ref.mime).toBe('image/jpeg');
  });

  it('destroy → 事件源 stop', () => {
    const { channel, src } = makeChannel();
    channel.start();
    channel.destroy();
    expect(src.source.stop).toHaveBeenCalled();
  });
});

describe('renderWechatText', () => {
  it('mention → @label；attachment → 防链接化占位（文件名的 . 后插零宽空格）', () => {
    const out = renderWechatText([
      { type: 'text', text: '你好 ' },
      { type: 'mention', target_sid: 'idp:user:a', label: '张三' },
      { type: 'attachment', asset_ref: { kind: 'file', uri: 'asset:x', name: '报告.pdf' } },
    ]);
    expect(out).toBe('你好 @张三[附件 报告.\u200Bpdf，微信端暂无法接收，可在 webchat 查看]');
    expect(out).not.toContain('报告.pdf'); // 原样文件名会被微信链接化
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
