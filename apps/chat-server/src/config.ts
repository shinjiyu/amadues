/**
 * chat-server 启动配置。
 *
 * 全部经由 env 读取，配合 `dotenv` 或外部进程注入。无任何编译期常量散落别处。
 */
import path from 'node:path';

export interface ChatServerConfig {
  port: number;
  dataRoot: string;
  globalThreadId: string;
  /**
   * 保留 user_id 集合：声称这些 user_id 之一的 WS hello 必须携带 agentSecret。
   * 空集 = 未启用保留（任意客户端可任意 user_id 上线）。
   * 多 agent（如 Kuroneko + Shiro 共用同一 chat-server）通过逗号分隔配置：
   *   WEBCHAT_AGENT_USER_ID=kuroneko,shiro
   * 多个 agent 共用一个 secret。
   */
  agentUserIds: Set<string>;
  agentSecret: string | null;
  /** CORS 白名单；`*` = 任意 */
  corsOrigin: string;
  /** 单文件大小上限（字节） */
  maxUploadSize: number;
  /** 单次历史拉取的硬上限 */
  maxMessagesPerPage: number;
}

export function loadConfig(): ChatServerConfig {
  const port = Number(process.env['PORT'] ?? 8790);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid PORT: ${process.env['PORT']}`);
  }

  const dataRoot = process.env['CHAT_SERVER_DATA_ROOT']?.trim()
    || path.join(process.cwd(), 'data', 'chat-server');

  const globalThreadId = process.env['WEBCHAT_GLOBAL_THREAD_ID']?.trim() || 'global';

  const agentUserIdsRaw = process.env['WEBCHAT_AGENT_USER_ID']?.trim() ?? '';
  const agentUserIds = new Set(
    agentUserIdsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  const agentSecret = process.env['WEBCHAT_AGENT_SECRET']?.trim() || null;

  const corsOrigin = process.env['CHAT_SERVER_CORS_ORIGIN']?.trim() || '*';

  const maxUploadSize = Number(process.env['CHAT_SERVER_MAX_UPLOAD_SIZE'] ?? 25 * 1024 * 1024);

  return {
    port,
    dataRoot,
    globalThreadId,
    agentUserIds,
    agentSecret,
    corsOrigin,
    maxUploadSize,
    maxMessagesPerPage: 200,
  };
}
