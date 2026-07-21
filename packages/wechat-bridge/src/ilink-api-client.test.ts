import { describe, expect, it } from 'vitest';
import {
  IlinkApiClient,
  IlinkApiError,
  fetchLoginQrcode,
  pollQrcodeStatus,
  randomWechatUin,
} from './ilink-api-client.js';
import { cipherSizeOf, decodeIlinkAesKey, encryptAesEcb } from './media-crypto.js';

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

  it('typing：getconfig（ilink_user_id）换 ticket → sendtyping status=1/2', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes('getconfig') ? jsonResponse({ typing_ticket: 'tk1' }) : jsonResponse({}),
    );
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    const ticket = await api.getTypingTicket('u@im.wechat', 'ctx1');
    expect(ticket).toBe('tk1');
    const cfgBody = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(cfgBody['ilink_user_id']).toBe('u@im.wechat');
    expect(cfgBody['context_token']).toBe('ctx1');

    await api.sendTyping('u@im.wechat', ticket!, true);
    const onBody = JSON.parse(String(calls[1]!.init!.body)) as Record<string, unknown>;
    expect(onBody['ilink_user_id']).toBe('u@im.wechat');
    expect(onBody['typing_ticket']).toBe('tk1');
    expect(onBody['status']).toBe(1);

    await api.sendTyping('u@im.wechat', ticket!, false);
    const offBody = JSON.parse(String(calls[2]!.init!.body)) as Record<string, unknown>;
    expect(offBody['status']).toBe(2);
  });

  it('downloadMedia：CDN download + AES 解密（media.aes_key 格式 B）', async () => {
    const keyHex = '00112233445566778899aabbccddeeff';
    const key = Buffer.from(keyHex, 'hex');
    const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]); // jpeg 签名
    const cipher = encryptAesEcb(plain, key);
    const { impl, calls } = fakeFetch(() => new Response(new Uint8Array(cipher), { status: 200 }));
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });

    const got = await api.downloadMedia({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: 'QPARAM=',
          aes_key: Buffer.from(keyHex, 'utf8').toString('base64'),
        },
      },
    });
    expect(got).toEqual(plain);
    expect(calls[0]!.url).toContain('novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=QPARAM%3D');
  });

  it('downloadMedia：无 CDN 引用 → null', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    expect(await api.downloadMedia({ type: 1, text_item: { text: 'x' } })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('uploadMedia：getuploadurl → CDN upload（x-encrypted-param）→ sendImageMessage', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes('getuploadurl')) return jsonResponse({ upload_param: 'UP=' });
      if (url.includes('/upload')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'DOWN=' } });
      }
      return jsonResponse({});
    });
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    const buf = Buffer.from('fake image bytes');
    const up = await api.uploadMedia({ buffer: buf, mediaType: 1, toUserId: 'u@im.wechat' });

    const reqBody = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(reqBody['media_type']).toBe(1);
    expect(reqBody['rawsize']).toBe(buf.length);
    expect(reqBody['filesize']).toBe(cipherSizeOf(buf.length));
    expect(reqBody['no_need_thumb']).toBe(true);
    expect(String(reqBody['aeskey'])).toMatch(/^[0-9a-f]{32}$/);

    expect(calls[1]!.url).toContain('/upload?encrypted_query_param=UP%3D&filekey=');
    expect(up.media.encrypt_query_param).toBe('DOWN=');
    // aes_key = base64(hex string)，可被兼容解码还原
    expect(decodeIlinkAesKey(up.media.aes_key)).toEqual(Buffer.from(String(reqBody['aeskey']), 'hex'));

    await api.sendImageMessage({
      toUserId: 'u@im.wechat',
      media: up.media,
      cipherSize: up.cipherSize,
      contextToken: 'ctx1',
    });
    const sendBody = JSON.parse(String(calls[2]!.init!.body)) as { msg: Record<string, unknown> };
    expect(sendBody.msg['item_list']).toEqual([
      { type: 2, image_item: { media: up.media, mid_size: up.cipherSize } },
    ]);
    expect(sendBody.msg['context_token']).toBe('ctx1');
  });

  it('sendFileMessage：item_list 带 file_name/md5/len（len 为字符串，协议要求）', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const api = new IlinkApiClient({ botToken: 'tok' }, { fetchImpl: impl });
    await api.sendFileMessage({
      toUserId: 'u@im.wechat',
      media: { encrypt_query_param: 'D=', aes_key: 'k' },
      fileName: '报告.pdf',
      rawSize: 123,
      rawMd5: 'abc123',
      contextToken: 'ctx1',
    });
    const body = JSON.parse(String(calls[0]!.init!.body)) as { msg: Record<string, unknown> };
    expect(body.msg['item_list']).toEqual([
      {
        type: 4,
        file_item: {
          media: { encrypt_query_param: 'D=', aes_key: 'k' },
          file_name: '报告.pdf',
          md5: 'abc123',
          len: '123',
        },
      },
    ]);
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
