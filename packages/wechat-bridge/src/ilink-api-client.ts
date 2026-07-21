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

/** iLink 消息 item（type: 1=text 2=image 3=voice 4=file 5=video） */
export interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: Record<string, unknown>;
  voice_item?: Record<string, unknown>;
  file_item?: Record<string, unknown>;
  video_item?: Record<string, unknown>;
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

  /** getconfig 换 typing_ticket（可按用户缓存约 24h） */
  async getTypingTicket(toUserId: string, contextToken?: string): Promise<string | null> {
    const data = await this.post('ilink/bot/getconfig', {
      to_user_id: toUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
    });
    const t = data['typing_ticket'];
    return typeof t === 'string' && t ? t : null;
  }

  /** status=1 显示「正在输入」，0 取消 */
  async sendTyping(toUserId: string, typingTicket: string, on: boolean): Promise<void> {
    await this.post('ilink/bot/sendtyping', {
      to_user_id: toUserId,
      typing_ticket: typingTicket,
      status: on ? 1 : 0,
    });
  }
}
