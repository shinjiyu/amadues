/**
 * ADL: wechatBridge · 连接配置与凭证
 * path: packages/wechat-bridge/src/config.ts
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6 P4b
 */

export const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** iLink 协议版本号（base_info.channel_version） */
export const ILINK_CHANNEL_VERSION = '1.0.2';

export interface WechatConnectionConfig {
  /** ilink_bot_id，形如 `xxxx@im.bot`（channel_key.scope / thread_id 用） */
  botId: string;
  /** 扫码登录返回的 Bearer token */
  botToken: string;
  /** 服务端返回的基座地址；以扫码返回值为准 */
  baseUrl?: string;
  /** 扫码授权的微信用户 ilink_user_id（`...@im.wechat`），仅记录 */
  ownerUserId?: string;
}

/**
 * keychain 里持有的凭证 JSON（扫码登录 confirmed 响应的持久化形态）。
 * registry `secret_ref` 解出的明文即这段 JSON。
 */
export interface WechatCredentials {
  token: string;
  baseUrl?: string;
  accountId: string;
  userId?: string;
  savedAt?: string;
}

export function parseWechatCredentials(secret: string): WechatCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error('wechat secret 不是合法 JSON（应为扫码登录返回的凭证对象）');
  }
  const o = parsed as Record<string, unknown>;
  const token = typeof o['token'] === 'string' ? o['token'].trim() : '';
  const accountId = typeof o['accountId'] === 'string' ? o['accountId'].trim() : '';
  if (!token || !accountId) {
    throw new Error('wechat secret 缺少 token / accountId 字段');
  }
  return {
    token,
    accountId,
    ...(typeof o['baseUrl'] === 'string' && o['baseUrl'] ? { baseUrl: o['baseUrl'] } : {}),
    ...(typeof o['userId'] === 'string' && o['userId'] ? { userId: o['userId'] } : {}),
    ...(typeof o['savedAt'] === 'string' && o['savedAt'] ? { savedAt: o['savedAt'] } : {}),
  };
}
