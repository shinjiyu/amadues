/**
 * 微信 iLink 会话/消息 ↔ chat IR id 映射。
 *
 * iLink 一号一连接，但同一 agent 可挂多个微信号 → thread_id 编入 bot_id
 * （与 feishu-bridge 编入 app_id 同理）：
 * - 私聊 `xxx@im.wechat`（bot e06@im.bot）→ IR `wechat:e06@im.bot:dm:xxx@im.wechat`
 * - 群（协议预留，基本收不到）      → IR `wechat:e06@im.bot:group:<group_id>`
 * - 消息 message_id                 → IR `wechat:e06@im.bot:msg:<id>`
 */

export function wechatDmToIr(botId: string, userId: string): string {
  return `wechat:${botId}:dm:${userId}`;
}

export function wechatGroupToIr(botId: string, groupId: string): string {
  return `wechat:${botId}:group:${groupId}`;
}

export interface WechatThreadRoute {
  botId: string;
  kind: 'dm' | 'group';
  /** dm = 对端用户 id；group = 群 id */
  peerId: string;
}

export function irThreadToWechat(irThreadId: string): WechatThreadRoute | null {
  const m = /^wechat:(.+?):(dm|group):(.+)$/.exec(irThreadId);
  if (!m) return null;
  return { botId: m[1]!, kind: m[2] as 'dm' | 'group', peerId: m[3]! };
}

export function isWechatIrThread(irThreadId: string): boolean {
  return /^wechat:.+?:(dm|group):/.test(irThreadId);
}

export function wechatMessageIdToIr(botId: string, messageId: string | number): string {
  return `wechat:${botId}:msg:${messageId}`;
}
