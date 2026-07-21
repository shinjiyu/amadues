import { describe, expect, it } from 'vitest';
import {
  ChatIRSeenTracker,
  IdentityRegistry,
  type ChatIRInboundEvent,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import { createWechatConnector } from './connector.js';
import type { WeixinMessage } from './ilink-api-client.js';

const BOT_ID = 'e06@im.bot';
const SECRET = JSON.stringify({
  token: 'ilinkbot_tok',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  accountId: BOT_ID,
  userId: 'owner@im.wechat',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeDeps(fetchImpl: typeof fetch) {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const inbound: ChatIRInboundEvent[] = [];
  return {
    deps: {
      agentSid: 'idp:agent:kuro',
      registry: new IdentityRegistry(null),
      seenTracker: new ChatIRSeenTracker({ selfAgentSid: 'idp:agent:kuro' }),
      loadThreads: () => store,
      saveThreads: () => {},
      makeInboundHandler: () => async (ev: ChatIRInboundEvent) => {
        inbound.push(ev);
      },
      fetchImpl,
    },
    inbound,
  };
}

describe('createWechatConnector', () => {
  it('secret JSON 解析 + 探测成功 → channel + botNativeId；探测批消息 prime 不丢', async () => {
    const primeMsg: WeixinMessage = {
      message_id: 1,
      from_user_id: 'alice@im.wechat',
      message_type: 1,
      context_token: 'ctx1',
      item_list: [{ type: 1, text_item: { text: '早于连接的消息' } }],
    };
    let getUpdatesCalls = 0;
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('getupdates')) {
        getUpdatesCalls += 1;
        // 第一次（探测）返回 prime 消息；之后空轮询
        if (getUpdatesCalls === 1) {
          return jsonResponse({ ret: 0, msgs: [primeMsg], get_updates_buf: 'buf1' });
        }
        return jsonResponse({ ret: 0, msgs: [], get_updates_buf: 'buf1' });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const { deps, inbound } = makeDeps(fetchImpl);
    const connector = createWechatConnector(deps);
    const result = await connector.connect({ connection_id: 'conn-1', app_id: BOT_ID }, SECRET);
    expect(result.botNativeId).toBe(BOT_ID);

    result.channel.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.message.parts).toEqual([{ type: 'text', text: '早于连接的消息' }]);
    result.channel.destroy?.();
  });

  it('token 失效（-14）→ connect 抛异常（registry 回滚）', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ ret: -14, errcode: -14, errmsg: 'session timeout' })) as typeof fetch;
    const { deps } = makeDeps(fetchImpl);
    const connector = createWechatConnector(deps);
    await expect(
      connector.connect({ connection_id: 'conn-1', app_id: BOT_ID }, SECRET),
    ).rejects.toThrow(/session timeout|failed/);
  });

  it('secret 不是凭证 JSON → 显式报错', async () => {
    const { deps } = makeDeps((async () => jsonResponse({})) as typeof fetch);
    const connector = createWechatConnector(deps);
    await expect(
      connector.connect({ connection_id: 'conn-1', app_id: BOT_ID }, 'not-json'),
    ).rejects.toThrow(/JSON/);
    await expect(
      connector.connect({ connection_id: 'conn-1', app_id: BOT_ID }, '{"foo":1}'),
    ).rejects.toThrow(/token/);
  });
});
