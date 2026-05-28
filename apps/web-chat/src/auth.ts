/**
 * 客户端鉴权 —— 与 loginserver hosted Nuxt 登录页对齐。
 *
 * SSO 成立条件：loginserver 前端与 webchat 挂在**同一 origin**（同 HTTPS 根域），
 * loginserver 登录后把 token 写到 localStorage，webchat 在同 origin 下读取。
 *
 * webchat 启动顺序：
 *   1. `consumeLoginserverTokens()`：发现 localStorage 里有 loginserver 写的 access_token →
 *      POST 到 chat-server `/auth/session` 换 HttpOnly cookie → 立刻清掉 localStorage
 *      （chat-server 那张 cookie 才是 webchat 的真正凭证，loginserver 的 localStorage 仅做载体）。
 *   2. `fetchCurrentIdentity()`：用 cookie 拉 `/auth/me`。
 *   3. 还没登录 → `redirectToLogin()` 跳到 loginserver `/login?redirect=<返回地址>`。
 *
 * webchat 自身**不再缓存** identity 到 localStorage（loginserver 那边的 `user` key 已经存了）—
 * 每次 boot 用 cookie + `/auth/me` 拉，结果在 React state 里，刷新页面再拉一次即可。
 */
const BASE_URL = import.meta.env.BASE_URL.replace(/\/+$/, '');
const API_BASE = `${BASE_URL}/api`;

export interface ClientIdentity {
  user_id: string;
  display_name: string;
  email: string;
  role: 'admin' | 'member';
}

export interface AuthConfig {
  /** 例 `/login`（同 origin 相对路径）或 `https://example.com/login`（绝对）。 */
  login_page_url: string;
  /** 默认 `redirect`，对应 loginserver `login.vue` 里读 URL 的参数名。 */
  return_param: string;
  /** localStorage 里 access token 的 key 名（loginserver 默认 `access_token`）。 */
  token_storage_key: string;
  refresh_storage_key: string;
  user_storage_key: string;
  logout_page_url: string;
}

let cachedAuthConfig: AuthConfig | null = null;

/** 从当前 URL 抹掉历史遗留的 ?token= / ?refresh_token=，避免 redirect 链越叠越长。 */
export function stripLegacyUrlTokens(config?: AuthConfig | null): void {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    const keys = [
      config?.token_storage_key,
      config?.refresh_storage_key,
      'token',
      'refresh_token',
      'access_token',
    ].filter(Boolean) as string[];
    for (const k of keys) {
      if (url.searchParams.has(k)) {
        url.searchParams.delete(k);
        changed = true;
      }
    }
    if (changed) {
      const next = url.pathname + (url.search ? url.search : '') + url.hash;
      window.history.replaceState({}, document.title, next);
    }
  } catch { /* ignore */ }
}

function cleanReturnUrl(): string {
  const url = new URL(window.location.href);
  for (const k of ['token', 'refresh_token', 'access_token']) {
    url.searchParams.delete(k);
  }
  return url.toString();
}

export async function fetchAuthConfig(force = false): Promise<AuthConfig> {
  if (!force && cachedAuthConfig) return cachedAuthConfig;
  const res = await fetch(`${API_BASE}/auth/config`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`无法获取登录配置 (${res.status})`);
  }
  cachedAuthConfig = (await res.json()) as AuthConfig;
  return cachedAuthConfig;
}

/**
 * 如果同 origin localStorage 里有 loginserver 写的 access_token，把它交给 chat-server
 * 换 HttpOnly cookie；成功后立刻清掉 localStorage 三件套，避免 token 长期暴露于前端 JS。
 *
 * 返回：
 *   - `null` —— localStorage 里没有 token
 *   - `ClientIdentity` —— 成功换到 cookie 并拿到 identity
 *   - throws —— token 在但 chat-server 拒绝（白名单未通过 / loginserver verify 失败）
 */
function readTokens(config: AuthConfig): { access: string | null; refresh: string | null } {
  let access: string | null = null;
  let refresh: string | null = null;
  try {
    access = localStorage.getItem(config.token_storage_key);
    refresh = config.refresh_storage_key
      ? localStorage.getItem(config.refresh_storage_key)
      : null;
  } catch { /* ignore */ }
  // 兼容旧版/异常回跳：token 被拼在 URL query 上
  if (!access) {
    const url = new URL(window.location.href);
    access =
      url.searchParams.get(config.token_storage_key) ||
      url.searchParams.get('token') ||
      url.searchParams.get('access_token');
    refresh =
      refresh ||
      (config.refresh_storage_key
        ? url.searchParams.get(config.refresh_storage_key)
        : null) ||
      url.searchParams.get('refresh_token');
  }
  return { access, refresh };
}

export async function consumeLoginserverTokens(): Promise<ClientIdentity | null> {
  const config = await fetchAuthConfig().catch(() => null);
  if (!config) return null;
  stripLegacyUrlTokens(config);
  const { access, refresh } = readTokens(config);
  if (!access) return null;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(refresh ? { token: access, refresh_token: refresh } : { token: access }),
    });
  } catch (e) {
    throw new Error(`无法连接 chat-server：${(e as Error).message}`);
  }
  type SessionBody = { ok?: boolean; user?: ClientIdentity; error?: string };
  let body: SessionBody | null = null;
  try { body = (await res.json()) as SessionBody; } catch { /* ignore */ }
  if (!res.ok || !body?.ok || !body?.user) {
    // 401/403：可能 token 已过期或没在白名单里；保险起见也清 localStorage 让用户重登
    clearLoginserverStorage(config);
    const message = body?.error || `换取登录态失败 (${res.status})`;
    throw new Error(message);
  }

  clearLoginserverStorage(config);
  stripLegacyUrlTokens(config);

  // 必须确认 cookie 已生效；否则清掉 localStorage 后会陷入「无限跳登录」
  const me = await fetchCurrentIdentity();
  if (me) return me;
  return body.user;
}

function clearLoginserverStorage(config: AuthConfig): void {
  try {
    if (config.token_storage_key) localStorage.removeItem(config.token_storage_key);
    if (config.refresh_storage_key) localStorage.removeItem(config.refresh_storage_key);
    if (config.user_storage_key) localStorage.removeItem(config.user_storage_key);
  } catch { /* ignore */ }
}

/** 调 `/api/auth/me`：返回 ClientIdentity 或 null（401 / 网络错）。 */
export async function fetchCurrentIdentity(): Promise<ClientIdentity | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ClientIdentity;
    if (typeof body?.user_id !== 'string') return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * 跳到 loginserver hosted 登录页；登录完成后 loginserver 会 `location.href = returnTo` 跳回。
 */
export function redirectToLogin(config: AuthConfig, returnTo?: string): void {
  if (!config.login_page_url) {
    throw new Error('WEBCHAT_LOGIN_PAGE_URL 未配置：服务器还没接好 loginserver hosted 登录页');
  }
  const back = returnTo || cleanReturnUrl();
  const sep = config.login_page_url.includes('?') ? '&' : '?';
  const url = `${config.login_page_url}${sep}${encodeURIComponent(config.return_param)}=${encodeURIComponent(back)}`;
  window.location.href = url;
}

/**
 * 登出：清 chat-server cookie + 清 loginserver 同 origin 的 localStorage；
 * 如果配了 hosted 登出页则跳过去（loginserver 那边可能还有自己的 session 要清）。
 */
export async function logout(): Promise<void> {
  let logoutPageUrl = '';
  try {
    const res = await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { logout_page_url?: string } | null;
      logoutPageUrl = body?.logout_page_url || '';
    }
  } catch { /* ignore */ }
  const config = await fetchAuthConfig().catch(() => null);
  if (config) clearLoginserverStorage(config);
  cachedAuthConfig = null;
  if (logoutPageUrl) {
    const sep = logoutPageUrl.includes('?') ? '&' : '?';
    window.location.href = `${logoutPageUrl}${sep}redirect=${encodeURIComponent(window.location.origin + BASE_URL + '/')}`;
  } else {
    window.location.reload();
  }
}
