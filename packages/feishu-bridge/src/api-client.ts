/**
 * 飞书开放平台 REST 客户端（自建应用 / tenant_access_token）。
 *
 * 只封装桥需要的最小面：token 缓存、发消息、回复、表情回复（Typing 模拟）、bot 信息。
 * `fetchImpl` 可注入（单测用 fake fetch，不出网）。
 *
 * 飞书响应约定：`{ code: 0, msg: 'success', data: {...} }`；`code !== 0` 视为错误。
 */
import { resolveFeishuDomain, type FeishuConnectionConfig } from './config.js';

export class FeishuApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly code: number,
    msg: string,
  ) {
    super(`feishu api ${endpoint} failed: code=${code} msg=${msg}`);
  }
}

interface FeishuEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
  /** tenant_access_token 接口把 token 平铺在顶层 */
  tenant_access_token?: string;
  expire?: number;
}

export interface SentMessage {
  message_id: string;
  chat_id: string;
  create_time?: string;
}

export interface BotInfo {
  /** bot 在本 app 的 open_id（ou_ 开头） */
  open_id: string;
  app_name?: string;
}

/** token 提前 5 分钟过期，避免边界失效 */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

export class FeishuApiClient {
  private readonly domain: string;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: FeishuConnectionConfig,
    opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.domain = resolveFeishuDomain(config);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  /** 探测凭证有效性（connector add 时调用；失败抛 FeishuApiError） */
  async probe(): Promise<void> {
    await this.getTenantAccessToken(true);
  }

  async getBotInfo(): Promise<BotInfo> {
    // bot/v3/info 是老式接口：bot 平铺在响应顶层（不在 data 里）；兼容两种形状
    type BotShape = { open_id: string; app_name?: string };
    const envelope = await this.requestEnvelope<{ bot?: BotShape; data?: { bot?: BotShape } }>(
      'GET',
      '/open-apis/bot/v3/info',
    );
    const bot = envelope.bot ?? envelope.data?.bot;
    if (!bot?.open_id) {
      throw new FeishuApiError(
        '/open-apis/bot/v3/info',
        envelope.code,
        '响应缺少 bot 信息——请确认应用已开启「机器人」能力并发布版本',
      );
    }
    return { open_id: bot.open_id, ...(bot.app_name ? { app_name: bot.app_name } : {}) };
  }

  /**
   * 发文本消息（含 at 标签）。`content` 是飞书 text 消息的 JSON 字符串
   * （`{"text":"<at user_id=\"ou_x\">名</at> 你好"}`），由调用方 render。
   */
  async sendTextMessage(chatId: string, contentJson: string): Promise<SentMessage> {
    const data = await this.request<SentMessage>(
      'POST',
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'text', content: contentJson },
    );
    return data;
  }

  /** 回复某条消息（threading 语义弱化为 reply_to；飞书群无独立 thread 概念） */
  async replyTextMessage(parentMessageId: string, contentJson: string): Promise<SentMessage> {
    const data = await this.request<SentMessage>(
      'POST',
      `/open-apis/im/v1/messages/${encodeURIComponent(parentMessageId)}/reply`,
      { msg_type: 'text', content: contentJson },
    );
    return data;
  }

  /**
   * 表情回复（Typing 指示模拟；channel-bridge-guide §5.4）。
   * 返回 reaction_id，撤销时用。
   */
  async createReaction(messageId: string, emojiType: string): Promise<string> {
    const data = await this.request<{ reaction_id: string }>(
      'POST',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { reaction_type: { emoji_type: emojiType } },
    );
    return data.reaction_id;
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
    );
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private async getTenantAccessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now()) {
      return this.token.value;
    }
    const res = await this.fetchImpl(
      `${this.domain}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      },
    );
    const body = (await res.json()) as FeishuEnvelope<never>;
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new FeishuApiError('tenant_access_token', body.code, body.msg ?? 'no token');
    }
    const ttlMs = (body.expire ?? 7200) * 1000;
    this.token = {
      value: body.tenant_access_token,
      expiresAt: this.now() + Math.max(60_000, ttlMs - TOKEN_SKEW_MS),
    };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, jsonBody?: unknown): Promise<T> {
    const body = await this.requestEnvelope<{ data?: T }>(method, path, jsonBody);
    return (body.data ?? ({} as T)) as T;
  }

  /** 完整响应信封（含顶层非 data 字段——bot/v3/info 等老式接口需要） */
  private async requestEnvelope<Extra extends object>(
    method: string,
    path: string,
    jsonBody?: unknown,
  ): Promise<{ code: number; msg: string } & Extra> {
    const token = await this.getTenantAccessToken();
    const res = await this.fetchImpl(`${this.domain}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
    });
    const body = (await res.json()) as { code: number; msg: string } & Extra;
    if (body.code !== 0) {
      // 99991663/99991661 = token 失效：清缓存，调用方重试一次即可拿新 token
      if (body.code === 99991663 || body.code === 99991661) this.token = null;
      throw new FeishuApiError(path, body.code, body.msg ?? 'unknown');
    }
    return body;
  }
}
