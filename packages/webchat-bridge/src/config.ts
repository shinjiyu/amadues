/**
 * WebChat 桥环境配置解析。
 *
 * 必填（任一缺失 = 不启用 WebChat channel）：`WEBCHAT_API_BASE`
 * 可选：
 *   `WEBCHAT_WS_URL`              （默认从 API_BASE 推导：http/https → ws/wss + /ws）
 *   `WEBCHAT_AGENT_USER_ID`       （默认 'agent'；适配器代表 agent 在 chat-server 的 user_id）
 *   `WEBCHAT_AGENT_DISPLAY_NAME`  （默认 'Agent'）
 *   `WEBCHAT_AGENT_SECRET`        （chat-server 端如配置了同名 env，必须对齐）
 *   `WEBCHAT_GLOBAL_THREAD_ID`    （默认 'global'，与 chat-server 端一致）
 *   `WEBCHAT_MIRROR_ASSETS`       （1/0；默认 0 = 引用外链，1 = 入站时镜像到 ChatAssetStore）
 *   `WEBCHAT_TENANT`              （写入 ThreadRecord.tenant_id；默认 'default'）
 */

export interface WebChatBridgeConfig {
  apiBase: string;
  wsUrl: string;
  agentUserId: string;
  agentDisplayName: string;
  agentSecret: string | null;
  globalThreadId: string;
  mirrorAssets: boolean;
  tenant: string;
  /**
   * 其它 agent 在 chat-server 里的 user_id（逗号分隔）。
   * 收到来自这些 user_id 的消息时，IR identity 将以 `kind='agent'` 注册，
   * outer-brain 的 senderIsAgent 判定才能识别"对方是 agent"，从而启用 agent 链限流、
   * 自言自语刹车、避免延续对话误判等。
   *
   * 当前 agent 自己的 `agentUserId` **不需要**列在这里——agent 自己的入站会被
   * webchat-channel 过滤；这里只列**其它 agent**。
   */
  peerAgentUserIds: Set<string>;
}

export function loadWebChatBridgeConfig(): WebChatBridgeConfig | null {
  const apiBase = process.env['WEBCHAT_API_BASE']?.trim();
  if (!apiBase) return null;
  const peerRaw = process.env['WEBCHAT_PEER_AGENT_USER_IDS']?.trim() ?? '';
  const peerAgentUserIds = new Set(
    peerRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return {
    apiBase: apiBase.replace(/\/+$/, ''),
    wsUrl: (process.env['WEBCHAT_WS_URL']?.trim() || deriveWsUrl(apiBase)),
    agentUserId: process.env['WEBCHAT_AGENT_USER_ID']?.trim() || 'agent',
    agentDisplayName: process.env['WEBCHAT_AGENT_DISPLAY_NAME']?.trim() || 'Agent',
    agentSecret: process.env['WEBCHAT_AGENT_SECRET']?.trim() || null,
    globalThreadId: process.env['WEBCHAT_GLOBAL_THREAD_ID']?.trim() || 'global',
    mirrorAssets: (process.env['WEBCHAT_MIRROR_ASSETS']?.trim() ?? '0') === '1',
    tenant: process.env['WEBCHAT_TENANT']?.trim() || 'default',
    peerAgentUserIds,
  };
}

function deriveWsUrl(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}/ws`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}/ws`;
  }
  return `${trimmed}/ws`;
}
