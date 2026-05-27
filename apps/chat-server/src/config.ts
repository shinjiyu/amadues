/**
 * chat-server 启动配置。
 *
 * 全部经由 env 读取，配合 `dotenv` 或外部进程注入。无任何编译期常量散落别处。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根 `.env.chat-server`（三 agent 保留 user_id）；不存在则仅用进程 env */
function loadRepoChatServerEnv(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const fp = path.join(repoRoot, '.env.chat-server');
  if (!fs.existsSync(fp)) return;
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadRepoChatServerEnv();

export interface ChatServerConfig {
  port: number;
  dataRoot: string;
  globalThreadId: string;
  /**
   * 保留 user_id 集合：声称这些 user_id 之一的 WS hello 必须携带 agentSecret。
   * 空集 = 未启用保留（任意客户端可任意 user_id 上线）。
   * 多 agent（如 Kuroneko + Shiro 共用同一 chat-server）通过逗号分隔配置：
   *   WEBCHAT_AGENT_USER_ID=kuroneko,shiro,gin
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
