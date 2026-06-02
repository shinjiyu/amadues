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

export interface AuthConfig {
  /** 是否对人类用户强制鉴权（公网部署必须 1）。0 时仍支持登录，但匿名也放行（仅本地调试）。 */
  required: boolean;
  /** loginserver 根 URL（如 `https://example.com`）。required=1 时必填。 */
  loginServerUrl: string | null;
  /**
   * loginserver JWT 签名密钥（与 `JWT_SECRET_KEY` 相同）。
   * 配置后 access token 本地 HS256 验签，不再 HTTP 调 `/api/auth/verify`。
   */
  loginJwtSecret: string | null;
  /** 白名单 JSON 持久化路径；默认 `${dataRoot}/auth.json`。 */
  authDataFile: string;
  /** 启动时种子的 admin email 列表（逗号分隔）。 */
  adminEmails: string[];
  /** Cookie secure：`auto`=按 X-Forwarded-Proto；`always`=强制；`never`=关闭。 */
  cookieSecure: 'auto' | 'always' | 'never';
  /** Cookie domain（如 `.example.com`）。省略则浏览器按当前 host 设。 */
  cookieDomain?: string;
  /** loginserver hosted 登录页 URL（可相对，如 `/login`）。 */
  loginPageUrl: string;
  /** 登录页用什么 query 参数收 return 地址。loginserver 默认 `redirect`。 */
  loginReturnParam: string;
  /** loginserver 把 access token 存到 localStorage 的 key（默认 `access_token`）。 */
  loginTokenStorageKey: string;
  /** loginserver 把 refresh token 存到 localStorage 的 key（默认 `refresh_token`）。 */
  loginRefreshStorageKey: string;
  /** loginserver 把 user 资料 JSON 存到 localStorage 的 key（默认 `user`）。 */
  loginUserStorageKey: string;
  /** 可选：loginserver hosted 登出页 URL。 */
  logoutPageUrl: string;
}

export interface ChatServerConfig {
  port: number;
  dataRoot: string;
  globalThreadId: string;
  /**
   * 可选 agent user_id 收紧列表（**非必填**）。
   *
   * - **留空**（推荐）：`WEBCHAT_AGENT_SECRET` 正确即可，任意 user_id 作为 agent 登录；新增 robot 无需改服务端。
   * - **非空**：在 secret 正确的基础上，仅允许列表内的 user_id（额外收紧，防 secret 泄露后冒用任意 id）。
   *
   * 多 agent 共用同一 secret 时无需在此枚举；该变量仅用于可选收紧或 dev 开放模式下的保留名保护。
   */
  agentUserIds: Set<string>;
  agentSecret: string | null;
  /** CORS 白名单；`*` = 任意（鉴权开启时不要用 `*`，浏览器会拒 credentials）。 */
  corsOrigin: string;
  /** 单文件大小上限（字节） */
  maxUploadSize: number;
  /** 单次历史拉取的硬上限 */
  maxMessagesPerPage: number;
  /** 鉴权相关。 */
  auth: AuthConfig;
  /**
   * 浏览器看到的 chat-server 公开根路径前缀（不含尾斜杠），用于附件 URL 拼接。
   * - 同源根路径部署：留空（默认）→ url = `/uploads/<id>`
   * - 子路径部署（如 nginx `/webchat/`）：`/webchat` → url = `/webchat/uploads/<id>`
   */
  publicBasePath: string;
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

  const required = parseBool(process.env['WEBCHAT_AUTH_REQUIRED']);
  const loginServerUrl =
    process.env['WEBCHAT_LOGIN_SERVER_URL']?.trim()?.replace(/\/$/, '') || null;
  const loginJwtSecret =
    process.env['WEBCHAT_LOGIN_JWT_SECRET']?.trim()
    || process.env['JWT_SECRET_KEY']?.trim()
    || null;
  if (required && !loginServerUrl) {
    throw new Error(
      'WEBCHAT_AUTH_REQUIRED=1 但缺少 WEBCHAT_LOGIN_SERVER_URL（应为 loginserver 根地址，如 https://example.com）',
    );
  }
  if (required && !loginJwtSecret) {
    console.warn(
      '[chat-server] WEBCHAT_AUTH_REQUIRED=1 但未配置 WEBCHAT_LOGIN_JWT_SECRET；'
        + '每个请求将 HTTP 调 loginserver /api/auth/verify（慢）。'
        + '请设与 loginserver JWT_SECRET_KEY 相同的值。',
    );
  }
  const authDataFile =
    process.env['WEBCHAT_AUTH_DATA_FILE']?.trim() || path.join(dataRoot, 'auth.json');
  const adminEmails = (process.env['WEBCHAT_ADMIN_EMAILS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const cookieSecureRaw = (process.env['WEBCHAT_COOKIE_SECURE']?.trim() || 'auto').toLowerCase();
  const cookieSecure: 'auto' | 'always' | 'never' =
    cookieSecureRaw === 'always' || cookieSecureRaw === 'never' ? cookieSecureRaw : 'auto';
  const cookieDomainRaw = process.env['WEBCHAT_COOKIE_DOMAIN']?.trim();
  const cookieDomain = cookieDomainRaw && cookieDomainRaw.length > 0 ? cookieDomainRaw : undefined;

  const loginPageUrl = (process.env['WEBCHAT_LOGIN_PAGE_URL']?.trim() || '').replace(/\/+$/, '');
  if (required && !loginPageUrl) {
    throw new Error(
      'WEBCHAT_AUTH_REQUIRED=1 但缺少 WEBCHAT_LOGIN_PAGE_URL（默认 loginserver 路径：`/login`）',
    );
  }
  const loginReturnParam = process.env['WEBCHAT_LOGIN_RETURN_PARAM']?.trim() || 'redirect';
  const loginTokenStorageKey =
    process.env['WEBCHAT_LOGIN_TOKEN_STORAGE_KEY']?.trim() || 'access_token';
  const loginRefreshStorageKey =
    process.env['WEBCHAT_LOGIN_REFRESH_STORAGE_KEY']?.trim() || 'refresh_token';
  const loginUserStorageKey =
    process.env['WEBCHAT_LOGIN_USER_STORAGE_KEY']?.trim() || 'user';
  const logoutPageUrl = (process.env['WEBCHAT_LOGOUT_PAGE_URL']?.trim() || '').replace(/\/+$/, '');

  const auth: AuthConfig = {
    required,
    loginServerUrl,
    loginJwtSecret,
    authDataFile,
    adminEmails,
    cookieSecure,
    ...(cookieDomain ? { cookieDomain } : {}),
    loginPageUrl,
    loginReturnParam,
    loginTokenStorageKey,
    loginRefreshStorageKey,
    loginUserStorageKey,
    logoutPageUrl,
  };

  let publicBasePath = (process.env['WEBCHAT_PUBLIC_BASE_PATH'] ?? '').trim();
  if (publicBasePath.endsWith('/')) publicBasePath = publicBasePath.replace(/\/+$/, '');
  if (publicBasePath && !publicBasePath.startsWith('/')) publicBasePath = `/${publicBasePath}`;

  return {
    port,
    dataRoot,
    globalThreadId,
    agentUserIds,
    agentSecret,
    corsOrigin,
    maxUploadSize,
    maxMessagesPerPage: 200,
    auth,
    publicBasePath,
  };
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}
