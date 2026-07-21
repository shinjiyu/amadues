import { describe, expect, it } from 'vitest';
import {
  IlinkApiClient,
  IlinkApiError,
  fetchLoginQrcode,
  pollQrcodeStatus,
  randomWechatUin,
} from './ilink-api-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Captured {
  url: string;
  init?: RequestInit;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Captured[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

describe('randomWechatUin', () => {
  it('base64(十进制 uint32)，每次不同概率极高', () => {
    const a = randomWechatUin();
    const decoded = Buffer.from(a, 'base64').toString('utf8');
    expect(String(Number(decoded))).toBe(decoded);
  });
});

describe('登录流（fetchLoginQrcode / pollQrcodeStatus）', () => {
  it('取二维码 → qrcode 令牌 + 渲染 URL', async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({ qrcode: 'qrc_1', qrcode_img_content: 'https://weixin.qq.com/x/abc' }),
    );
    const qr = await fetchLoginQrcode({ fetchImpl: impl });
    expect(qr).toEqual({ qrcode: 'qrc_1', qrcodeUrl: 'https://weixin.qq.com/x/abc' });
    expect(calls[0]!.url).toContain('/ilink/bot/get_bot_qrcode?bot_type=3');
  });

  it('轮询 confirmed → 返回凭证（含 baseurl）', async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({
        status: 'confirmed',
        bot_token: 'ilinkbot_tok',
        ilink_bot_id: 'e06@im.bot',
        ilink_user_id: 'u1@im.wechat',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }),
    );
    const st = await pollQrcodeStatus('qrc_1', { fetchImpl: impl });
    expect(st).toEqual({
      status: 'confirmed',
      botToken: 'ilinkbot_tok',
      botId: 'e06@im.bot',
      userId: 'u1@im.wechat',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
  });

  it('wait / scaned / expired 原样透传', async () => {
    for (const status of ['wait', 'scaned', 'expired'] as const) {
      const { impl } = fakeFetch(() => jsonResponse({ status }));
      expect(await pollQrcodeStatus('q', { fetchImpl: impl })).toEqual({ status });
    }
  });
});

describe('IlinkApiClient 业务请求', () => {
  it('getupdates：通用头（Bearer + AuthorizationType + X-WECHAT-UIN）+ base_info；解析 msgs/buf', async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({
        ret: 0,
        msgs: [{ message_id: 1, from_user_id: 'u@im.wechat', message_type: 1 }],
        get_updates_buf: 'buf2',
        longpolling_timeout_ms: 35000,
      }),
    );
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    const r = await api.getUpdates('buf1');
    expect(r.msgs).toHaveLength(1);
    expect(r.buf).toBe('buf2');
    expect(r.longPollTimeoutMs).toBe(35000);

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['AuthorizationType']).toBe('ilink_bot_token');
    expect(headers['X-WECHAT-UIN']).toBeTruthy();
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body['get_updates_buf']).toBe('buf1');
    expect(body['base_info']).toEqual({ channel_version: '1.0.2' });
  });

  it('getupdates -14 → IlinkApiError.sessionExpired', async () => {
    const { impl } = fakeFetch(() => jsonResponse({ ret: -14, errcode: -14, errmsg: 'session timeout' }));
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    const err = await api.getUpdates('').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IlinkApiError);
    expect((err as IlinkApiError).sessionExpired).toBe(true);
  });

  it('sendmessage：必须回传 context_token；body 形状符合协议', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    await api.sendTextMessage({
      toUserId: 'u@im.wechat',
      text: '你好',
      contextToken: 'ctx1',
      clientId: 'cid-1',
    });
    const body = JSON.parse(String(calls[0]!.init!.body)) as {
      msg: Record<string, unknown>;
    };
    expect(body.msg['to_user_id']).toBe('u@im.wechat');
    expect(body.msg['message_type']).toBe(2);
    expect(body.msg['message_state']).toBe(2);
    expect(body.msg['context_token']).toBe('ctx1');
    expect(body.msg['client_id']).toBe('cid-1');
    expect(body.msg['item_list']).toEqual([{ type: 1, text_item: { text: '你好' } }]);
  });

  it('sendmessage 缺 context_token → 拒发', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    await expect(
      api.sendTextMessage({ toUserId: 'u', text: 'x', contextToken: '' }),
    ).rejects.toThrow(/context_token/);
    expect(calls).toHaveLength(0);
  });

  it('typing：getconfig 换 ticket → sendtyping status=1/0', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes('getconfig') ? jsonResponse({ typing_ticket: 'tk1' }) : jsonResponse({}),
    );
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    const ticket = await api.getTypingTicket('u@im.wechat', 'ctx1');
    expect(ticket).toBe('tk1');
    await api.sendTyping('u@im.wechat', ticket!, true);
    const body = JSON.parse(String(calls[1]!.init!.body)) as Record<string, unknown>;
    expect(body['typing_ticket']).toBe('tk1');
    expect(body['status']).toBe(1);
  });

  it('自定义 baseUrl（扫码返回的 baseurl 优先）', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ ret: 0, msgs: [], get_updates_buf: '' }));
    const api = new IlinkApiClient(
      { botToken: 'tok', baseUrl: 'https://alt.example.com' },
      { fetchImpl: impl },
    );
    await api.getUpdates('');
    expect(calls[0]!.url).toBe('https://alt.example.com/ilink/bot/getupdates');
  });
});
