import { describe, expect, it } from 'vitest';
import { FeishuApiClient, FeishuApiError } from './api-client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fake fetch：按 URL 片段返回预置响应，并记录所有调用 */
function makeFakeFetch(routes: Array<{ match: string; response: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no route for ${url}`);
    return { json: async () => route.response } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN_OK = {
  match: 'tenant_access_token',
  response: { code: 0, msg: 'ok', tenant_access_token: 't-abc', expire: 7200 },
};

function makeClient(routes: Array<{ match: string; response: unknown }>, now?: () => number) {
  const { fetchImpl, calls } = makeFakeFetch(routes);
  const client = new FeishuApiClient(
    { appId: 'cli_a', appSecret: 's3cret' },
    { fetchImpl, ...(now ? { now } : {}) },
  );
  return { client, calls };
}

describe('FeishuApiClient', () => {
  it('token 获取 + 缓存：两次请求只取一次 token', async () => {
    const { client, calls } = makeClient([
      TOKEN_OK,
      { match: '/im/v1/messages', response: { code: 0, msg: 'ok', data: { message_id: 'om_1', chat_id: 'oc_1' } } },
    ]);
    await client.sendTextMessage('oc_1', '{"text":"hi"}');
    await client.sendTextMessage('oc_1', '{"text":"again"}');
    const tokenCalls = calls.filter((c) => c.url.includes('tenant_access_token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.body).toEqual({ app_id: 'cli_a', app_secret: 's3cret' });
  });

  it('token 过期后自动续取', async () => {
    let t = 0;
    const { client, calls } = makeClient(
      [
        TOKEN_OK,
        { match: '/im/v1/messages', response: { code: 0, msg: 'ok', data: { message_id: 'om', chat_id: 'oc' } } },
      ],
      () => t,
    );
    await client.sendTextMessage('oc', '{"text":"a"}');
    t = 8000 * 1000; // 超过 expire-skew
    await client.sendTextMessage('oc', '{"text":"b"}');
    expect(calls.filter((c) => c.url.includes('tenant_access_token'))).toHaveLength(2);
  });

  it('sendTextMessage 请求形状正确（receive_id_type=chat_id + Bearer）', async () => {
    const { client, calls } = makeClient([
      TOKEN_OK,
      { match: '/im/v1/messages', response: { code: 0, msg: 'ok', data: { message_id: 'om_9', chat_id: 'oc_9' } } },
    ]);
    const sent = await client.sendTextMessage('oc_9', '{"text":"你好"}');
    expect(sent.message_id).toBe('om_9');
    const call = calls.find((c) => c.url.includes('/im/v1/messages'))!;
    expect(call.url).toContain('receive_id_type=chat_id');
    expect(call.method).toBe('POST');
    expect(call.headers['Authorization']).toBe('Bearer t-abc');
    expect(call.body).toEqual({ receive_id: 'oc_9', msg_type: 'text', content: '{"text":"你好"}' });
  });

  it('reaction 创建/删除（Typing 模拟的底座）', async () => {
    const { client, calls } = makeClient([
      TOKEN_OK,
      {
        match: '/reactions',
        response: { code: 0, msg: 'ok', data: { reaction_id: 'r-1' } },
      },
    ]);
    const rid = await client.createReaction('om_h1', 'Typing');
    expect(rid).toBe('r-1');
    await client.deleteReaction('om_h1', rid);
    const reactionCalls = calls.filter((c) => c.url.includes('/reactions'));
    expect(reactionCalls[0]!.method).toBe('POST');
    expect(reactionCalls[0]!.body).toEqual({ reaction_type: { emoji_type: 'Typing' } });
    expect(reactionCalls[1]!.method).toBe('DELETE');
    expect(reactionCalls[1]!.url).toContain('/reactions/r-1');
  });

  it('code !== 0 抛 FeishuApiError（probe 凭证错误可被 registry 捕获）', async () => {
    const { client } = makeClient([
      { match: 'tenant_access_token', response: { code: 10003, msg: 'invalid app_secret' } },
    ]);
    await expect(client.probe()).rejects.toThrowError(FeishuApiError);
    await expect(client.probe()).rejects.toThrow(/invalid app_secret/);
  });

  it('getBotInfo：bot/v3/info 是老式响应，bot 在顶层（真实 API 形状）', async () => {
    const { client } = makeClient([
      TOKEN_OK,
      {
        match: '/bot/v3/info',
        // 真实响应：bot 平铺在顶层，不在 data 里
        response: {
          code: 0,
          msg: 'ok',
          bot: { activate_status: 2, app_name: 'Kuro', open_id: 'ou_bot', ip_white_list: [] },
        },
      },
    ]);
    const bot = await client.getBotInfo();
    expect(bot).toEqual({ open_id: 'ou_bot', app_name: 'Kuro' });
  });

  it('getBotInfo 兼容 data.bot 形状', async () => {
    const { client } = makeClient([
      TOKEN_OK,
      { match: '/bot/v3/info', response: { code: 0, msg: 'ok', data: { bot: { open_id: 'ou_bot2' } } } },
    ]);
    const bot = await client.getBotInfo();
    expect(bot.open_id).toBe('ou_bot2');
  });

  it('getBotInfo 无 bot 字段 → 明确报错（未开机器人能力），而非 TypeError', async () => {
    const { client } = makeClient([
      TOKEN_OK,
      { match: '/bot/v3/info', response: { code: 0, msg: 'ok' } },
    ]);
    await expect(client.getBotInfo()).rejects.toThrow(/机器人/);
  });
});
