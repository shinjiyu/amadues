/**
 * ADL: wechatBridge · IlinkApiClient
 * path: packages/wechat-bridge/src/ilink-api-client.ts
 * horizon.intention: 微信 iLink Bot API（ilinkai.weixin.qq.com）HTTP/JSON 封装：
 *   扫码登录、getupdates 长轮询、sendmessage（context_token 回传）、sendtyping。
 * horizon.in:  fetch（可注入）；bot_token（扫码登录所得）
 * horizon.out: WeixinMessage[]；发送/typing 副作用
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6 P4b
 */
import crypto from 'node:crypto';
import { DEFAULT_ILINK_BASE_URL, ILINK_CHANNEL_VERSION } from './config.js';
import {
  DEFAULT_CDN_BASE_URL,
  aesKeyHexToB64,
  cipherSizeOf,
  decodeIlinkAesKey,
  decryptAesEcb,
  encryptAesEcb,
  randomAesKeyHex,
} from './media-crypto.js';

/** 图片/语音/文件/视频共用的 CDN 引用 */
export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

/** iLink 消息 item（type: 1=text 2=image 3=voice 4=file 5=video） */
export interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: {
    media?: CdnMedia;
    thumb_media?: CdnMedia;
    /** 32 位 hex；入站图片可能直接给，优先于 media.aes_key */
    aeskey?: string;
    url?: string;
    mid_size?: number;
  };
  voice_item?: { media?: CdnMedia; encode_type?: number; text?: string; playtime?: number };
  file_item?: { media?: CdnMedia; file_name?: string; md5?: string; len?: number | string };
  video_item?: { media?: CdnMedia; thumb_media?: CdnMedia; video_size?: number };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  /** 1 = USER，2 = BOT */
  message_type?: number;
  /** 0 = NEW，1 = GENERATING，2 = FINISH */
  message_state?: number;
  item_list?: WeixinMessageItem[];
  /** 会话上下文令牌；回复时必须回传 */
  context_token?: string;
}

export interface GetUpdatesResult {
  msgs: WeixinMessage[];
  /** 新游标（非空才更新） */
  buf: string;
  /** 服务端建议的下次长轮询超时 */
  longPollTimeoutMs?: number;
}

export class IlinkApiError extends Error {
  constructor(
    message: string,
    readonly ret: number,
    /** -14 = session 过期，需重新扫码 */
    readonly sessionExpired: boolean,
  ) {
    super(message);
    this.name = 'IlinkApiError';
  }
}

/** 随机 uint32 → 十进制字符串 → base64（每次请求重新生成） */
export function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

export interface IlinkApiClientOptions {
  fetchImpl?: typeof fetch;
}

export interface IlinkLoginQrcode {
  /** 轮询令牌 */
  qrcode: string;
  /** 可直接渲染为二维码/发给用户的 URL */
  qrcodeUrl: string;
}

export type IlinkQrcodeStatus =
  | { status: 'wait' | 'scaned' | 'expired' }
  | {
      status: 'confirmed';
      botToken: string;
      botId: string;
      userId: string;
      baseUrl: string;
    };

/** 登录接口不需要 bot_token，做成独立函数（工具侧扫码流用） */
export async function fetchLoginQrcode(
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<IlinkLoginQrcode> {
  const base = opts.baseUrl ?? DEFAULT_ILINK_BASE_URL;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`);
  if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}`);
  const data = (await res.json()) as { qrcode?: string; qrcode_img_content?: string };
  if (!data.qrcode || !data.qrcode_img_content) {
    throw new Error('get_bot_qrcode 响应缺少 qrcode / qrcode_img_content');
  }
  return { qrcode: data.qrcode, qrcodeUrl: data.qrcode_img_content };
}

export async function pollQrcodeStatus(
  qrcode: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<IlinkQrcodeStatus> {
  const base = opts.baseUrl ?? DEFAULT_ILINK_BASE_URL;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
    headers: { 'iLink-App-ClientVersion': '1' },
  });
  if (!res.ok) throw new Error(`get_qrcode_status HTTP ${res.status}`);
  const data = (await res.json()) as {
    status?: string;
    bot_token?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
    baseurl?: string;
  };
  if (data.status === 'confirmed') {
    if (!data.bot_token || !data.ilink_bot_id) {
      throw new Error('get_qrcode_status confirmed 但缺少 bot_token / ilink_bot_id');
    }
    return {
      status: 'confirmed',
      botToken: data.bot_token,
      botId: data.ilink_bot_id,
      userId: data.ilink_user_id ?? '',
      baseUrl: data.baseurl ?? base,
    };
  }
  if (data.status === 'wait' || data.status === 'scaned' || data.status === 'expired') {
    return { status: data.status };
  }
  return { status: 'wait' };
}

export class IlinkApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly auth: { botToken: string; baseUrl?: string },
    opts: IlinkApiClientOptions = {},
  ) {
    this.baseUrl = auth.baseUrl ?? DEFAULT_ILINK_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    init: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${this.auth.botToken}`,
        'X-WECHAT-UIN': randomWechatUin(),
      },
      body: JSON.stringify({ ...body, base_info: { channel_version: ILINK_CHANNEL_VERSION } }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok) {
      throw new IlinkApiError(`${path} HTTP ${res.status}`, res.status, res.status === 401);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const ret = typeof data['ret'] === 'number' ? data['ret'] : 0;
    const errcode = typeof data['errcode'] === 'number' ? data['errcode'] : 0;
    const code = ret !== 0 ? ret : errcode;
    if (code !== 0) {
      const msg = typeof data['errmsg'] === 'string' ? data['errmsg'] : `ret=${code}`;
      throw new IlinkApiError(`${path} failed: ${msg}`, code, code === -14);
    }
    return data;
  }

  /** 长轮询收消息；首次 buf 传空串。AbortError 由调用方按「空轮询」处理。 */
  async getUpdates(buf: string, opts: { signal?: AbortSignal } = {}): Promise<GetUpdatesResult> {
    const data = await this.post(
      'ilink/bot/getupdates',
      { get_updates_buf: buf },
      opts.signal ? { signal: opts.signal } : {},
    );
    const msgs = Array.isArray(data['msgs']) ? (data['msgs'] as WeixinMessage[]) : [];
    const newBuf = typeof data['get_updates_buf'] === 'string' ? data['get_updates_buf'] : '';
    const t = data['longpolling_timeout_ms'];
    return {
      msgs,
      buf: newBuf || buf,
      ...(typeof t === 'number' ? { longPollTimeoutMs: t } : {}),
    };
  }

  /** 发文本；contextToken 为入站缓存的会话锚点（缺失 = 无法安全路由，拒发） */
  async sendTextMessage(input: {
    toUserId: string;
    text: string;
    contextToken: string;
    clientId?: string;
  }): Promise<{ clientId: string }> {
    if (!input.contextToken) {
      throw new Error('sendmessage 需要 context_token（该会话还没有入站消息锚点）');
    }
    const clientId = input.clientId ?? `utlra-wechat:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await this.post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: input.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        item_list: [{ type: 1, text_item: { text: input.text } }],
      },
    });
    return { clientId };
  }

  /** getconfig 换 typing_ticket（可按用户缓存约 24h）；协议字段是 ilink_user_id（对端用户） */
  async getTypingTicket(toUserId: string, contextToken?: string): Promise<string | null> {
    const data = await this.post('ilink/bot/getconfig', {
      ilink_user_id: toUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
    });
    const t = data['typing_ticket'];
    return typeof t === 'string' && t ? t : null;
  }

  /** status=1 显示「正在输入」，2 取消 */
  async sendTyping(toUserId: string, typingTicket: string, on: boolean): Promise<void> {
    await this.post('ilink/bot/sendtyping', {
      ilink_user_id: toUserId,
      typing_ticket: typingTicket,
      status: on ? 1 : 2,
    });
  }

  // ── 媒体（CDN AES-128-ECB）────────────────────────────────────────────

  private cdnBaseUrl(): string {
    return DEFAULT_CDN_BASE_URL;
  }

  /**
   * 下载并解密一个媒体 item（image/voice/file/video）。
   * 返回 null = item 没有可下载的 CDN 引用。
   */
  async downloadMedia(item: WeixinMessageItem): Promise<Buffer | null> {
    const media =
      item.image_item?.media ?? item.voice_item?.media ?? item.file_item?.media ?? item.video_item?.media;
    const param = media?.encrypt_query_param;
    if (!param) return null;

    const url = `${this.cdnBaseUrl()}/download?encrypted_query_param=${encodeURIComponent(param)}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new IlinkApiError(`cdn download HTTP ${res.status}`, res.status, false);
    const cipher = Buffer.from(await res.arrayBuffer());

    const key = decodeIlinkAesKey(media?.aes_key, item.image_item?.aeskey);
    if (!key) return cipher; // 无 key：按明文返回（协议允许）
    try {
      return decryptAesEcb(cipher, key);
    } catch (e) {
      throw new Error(`媒体解密失败（key 编码不兼容？）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 上传媒体：getuploadurl → AES 加密 → CDN upload。
   * 返回可塞进 sendmessage item 的 CDN 引用与密文大小。
   */
  async uploadMedia(input: {
    buffer: Buffer;
    /** 1=IMAGE 2=VIDEO 3=FILE 4=VOICE */
    mediaType: 1 | 2 | 3 | 4;
    toUserId: string;
  }): Promise<{ media: CdnMedia; cipherSize: number }> {
    const aeskeyHex = randomAesKeyHex();
    const key = Buffer.from(aeskeyHex, 'hex');
    const cipher = encryptAesEcb(input.buffer, key);
    const filekey = crypto.randomBytes(16).toString('hex');

    const up = await this.post('ilink/bot/getuploadurl', {
      filekey,
      media_type: input.mediaType,
      to_user_id: input.toUserId,
      rawsize: input.buffer.length,
      rawfilemd5: crypto.createHash('md5').update(input.buffer).digest('hex'),
      filesize: cipherSizeOf(input.buffer.length),
      no_need_thumb: true,
      aeskey: aeskeyHex,
    });
    const uploadParam = typeof up['upload_param'] === 'string' ? up['upload_param'] : '';
    if (!uploadParam) throw new Error('getuploadurl 未返回 upload_param');

    const url = `${this.cdnBaseUrl()}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(cipher),
    });
    if (!res.ok) throw new IlinkApiError(`cdn upload HTTP ${res.status}`, res.status, false);
    const encryptedParam = res.headers.get('x-encrypted-param');
    if (!encryptedParam) throw new Error('CDN upload 未返回 x-encrypted-param');

    return {
      media: {
        encrypt_query_param: encryptedParam,
        aes_key: aesKeyHexToB64(aeskeyHex),
        encrypt_type: 1,
      },
      cipherSize: cipher.length,
    };
  }

  /** 发图片（先 uploadMedia mediaType=1） */
  async sendImageMessage(input: {
    toUserId: string;
    media: CdnMedia;
    cipherSize: number;
    contextToken: string;
    clientId?: string;
  }): Promise<{ clientId: string }> {
    return this.sendItemMessage(input.toUserId, input.contextToken, {
      type: 2,
      image_item: { media: input.media, mid_size: input.cipherSize },
    }, input.clientId);
  }

  /** 发文件（先 uploadMedia mediaType=3） */
  async sendFileMessage(input: {
    toUserId: string;
    media: CdnMedia;
    fileName: string;
    rawSize: number;
    contextToken: string;
    clientId?: string;
  }): Promise<{ clientId: string }> {
    return this.sendItemMessage(input.toUserId, input.contextToken, {
      type: 4,
      file_item: { media: input.media, file_name: input.fileName, len: input.rawSize },
    }, input.clientId);
  }

  private async sendItemMessage(
    toUserId: string,
    contextToken: string,
    item: WeixinMessageItem,
    clientIdIn?: string,
  ): Promise<{ clientId: string }> {
    if (!contextToken) {
      throw new Error('sendmessage 需要 context_token（该会话还没有入站消息锚点）');
    }
    const clientId = clientIdIn ?? `utlra-wechat:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await this.post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [item],
      },
    });
    return { clientId };
  }
}
