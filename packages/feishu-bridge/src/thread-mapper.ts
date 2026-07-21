/**
 * 飞书 chat/message ↔ chat IR id 映射。
 *
 * 飞书**多 app 非单例**：同一个物理群在不同 app 眼里 chat_id 不同（oc_ 开头、
 * per-app），thread_id 里编入 app_id 即可保证：
 * 1. 多连接下全局唯一（fan-in 的 thread→connection 路由天然成立）；
 * 2. 出站时能反查出该消息该走哪个 app。
 *
 * - 飞书 chat `oc_xxx`（app cli_a）→ IR `feishu:cli_a:chat:oc_xxx`
 * - 飞书 message `om_xxx`（app cli_a）→ IR `feishu:cli_a:msg:om_xxx`
 */

export function feishuChatToIr(appId: string, chatId: string): string {
  return `feishu:${appId}:chat:${chatId}`;
}

export function irThreadToFeishuChat(irThreadId: string): { appId: string; chatId: string } | null {
  const m = /^feishu:([^:]+):chat:(.+)$/.exec(irThreadId);
  if (!m) return null;
  return { appId: m[1]!, chatId: m[2]! };
}

export function isFeishuIrThread(irThreadId: string): boolean {
  return /^feishu:[^:]+:chat:/.test(irThreadId);
}

export function feishuMessageIdToIr(appId: string, messageId: string): string {
  return `feishu:${appId}:msg:${messageId}`;
}

export function irMessageIdToFeishu(irId: string): { appId: string; messageId: string } | null {
  const m = /^feishu:([^:]+):msg:(.+)$/.exec(irId);
  if (!m) return null;
  return { appId: m[1]!, messageId: m[2]! };
}
