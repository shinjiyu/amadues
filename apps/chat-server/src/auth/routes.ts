/**
 * `/auth/*` + `/admin/whitelist/*` 路由。
 *
 * 登录流程（与 `D:/UGit/loginserver` 的实际行为对齐）：
 *   1. 浏览器访问 `/webchat/`，未登录 → 前端 redirect 到 loginserver hosted Nuxt 登录页
 *      `{login_page_url}?{return_param}=<回到 webchat 的 URL>`（默认 `/login?redirect=...`）。
 *   2. 用户登录成功 → loginserver 前端把 `access_token` / `refresh_token` / `user` 三个 key
 *      写到 **同 origin** 的 `localStorage`，然后 `location.href = redirect`。
 *      跨子站 SSO 之所以成立：webchat 与 loginserver Nuxt 都挂在 `kuroneko.chat` 根域下，
 *      localStorage 同 origin 自动共享，token 不需要拼到 URL，也不会落到 nginx access log。
 *   3. 回到 `/webchat/` 后，前端读 localStorage 里的 access_token，POST 到本路由
 *      `/auth/session`，本路由通过 loginserver `/api/auth/verify` 验 token + 白名单校验 →
 *      种 HttpOnly cookie；之后前端立刻清掉 localStorage 里的 token，缩小 XSS 暴露面。
 *
 * `/auth/config` 暴露的 `token_storage_key` / `refresh_storage_key` 就是
 * **localStorage 的 key 名**（loginserver 现行实现为 `access_token` / `refresh_token`）。
 *
 * - `/auth/config`：公开。前端用它得知 login 页地址、return 参数名、localStorage key。
 * - `/auth/session`：交换 loginserver token → chat-server cookie。
 * - `/auth/logout`：清 cookie；额外返回 loginserver 登出页 URL（如果配了）。
 * - `/auth/me`：从 cookie 解出当前用户（authMiddleware 已注入 principal）。
 * - `/admin/whitelist/*`：管理 WebChat 白名单（必须 admin）。
 */
import { Hono } from 'hono';

import {
  clearAuthCookiesHono,
  isHonoRequestSecure,
  setAuthCookiesHono,
} from './cookies.js';
import type { AuthService } from './service.js';
import { requireAdmin, requireAuthed } from './middleware.js';
import type { Role, WhitelistStatus } from './types.js';

export interface AuthRoutesConfig {
  /** loginserver hosted 登录页 URL；可以是相对路径（同 origin，如 `/login`）或绝对路径。 */
  loginPageUrl: string;
  /** loginserver 登录页用来接收"登录完跳回哪里"的 query 参数名（loginserver 实测：`redirect`）。 */
  returnParam: string;
  /** loginserver 把 access token 存到 localStorage 的 key 名（loginserver 实测：`access_token`）。 */
  tokenStorageKey: string;
  /** loginserver 把 refresh token 存到 localStorage 的 key 名（loginserver 实测：`refresh_token`）。 */
  refreshStorageKey: string;
  /** loginserver 把 user 资料 JSON 存到 localStorage 的 key 名（loginserver 实测：`user`）。 */
  userStorageKey: string;
  /** 可选：loginserver hosted 登出页 URL。前端登出后会跳过去。 */
  logoutPageUrl: string;
}

export function buildAuthRoutes(service: AuthService, cfg: AuthRoutesConfig): Hono {
  const r = new Hono();

  r.get('/auth/config', (c) =>
    c.json({
      login_page_url: cfg.loginPageUrl,
      return_param: cfg.returnParam,
      token_storage_key: cfg.tokenStorageKey,
      refresh_storage_key: cfg.refreshStorageKey,
      user_storage_key: cfg.userStorageKey,
      logout_page_url: cfg.logoutPageUrl,
    }),
  );

  r.post('/auth/session', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { token?: unknown; refresh_token?: unknown }
      | null;
    const accessToken = String(body?.token ?? '').trim();
    const refreshToken = body?.refresh_token ? String(body.refresh_token).trim() : '';
    if (!accessToken) {
      return c.json({ error: 'token is required' }, 400);
    }
    let verified;
    try {
      verified = await service.login.verify(accessToken);
    } catch (e) {
      console.error('[chat-server][auth] verify failed:', (e as Error).message);
      return c.json({ error: 'upstream auth service unavailable' }, 502);
    }
    if (!verified) {
      return c.json({ error: 'invalid or expired token' }, 401);
    }
    const principal = await service.onLoginSuccess(
      verified.email,
      verified.user_id,
      undefined,
    );
    if (!principal) {
      return c.json({ error: 'account is not whitelisted' }, 403);
    }
    setAuthCookiesHono(
      c,
      refreshToken
        ? { access: accessToken, refresh: refreshToken }
        : { access: accessToken },
      service.cookieOptsFor(isHonoRequestSecure(c)),
    );
    return c.json({
      ok: true,
      user: {
        user_id: principal.userId,
        email: principal.email,
        display_name: principal.displayName,
        role: principal.role,
      },
    });
  });

  r.post('/auth/logout', (c) => {
    clearAuthCookiesHono(c, service.cookieOptsFor(isHonoRequestSecure(c)));
    return c.json({ ok: true, logout_page_url: cfg.logoutPageUrl });
  });

  r.get('/auth/me', requireAuthed, (c) => {
    const p = c.var.principal;
    if (p.kind !== 'user') {
      return c.json({ error: 'not a human user' }, 403);
    }
    return c.json({
      user_id: p.userId,
      email: p.email,
      display_name: p.displayName,
      role: p.role,
    });
  });

  // ── Admin: whitelist 管理 ────────────────────────────────────────
  r.get('/admin/whitelist', requireAdmin, (c) =>
    c.json({ entries: service.store.listWhitelist() }),
  );

  r.post('/admin/whitelist', requireAdmin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { email?: unknown; role?: unknown; display_name?: unknown }
      | null;
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return c.json({ error: 'valid email required' }, 400);
    }
    const role: Role = body?.role === 'admin' ? 'admin' : 'member';
    const me = c.var.principal as { email?: string };
    const displayName = String(body?.display_name ?? '').trim() || undefined;
    const entry = await service.store.upsert({
      email,
      role,
      status: 'active',
      addedBy: me.email ?? 'admin',
      ...(displayName ? { displayName } : {}),
    });
    return c.json({ entry });
  });

  r.patch('/admin/whitelist/:email', requireAdmin, async (c) => {
    const target = decodeURIComponent(c.req.param('email') ?? '').trim().toLowerCase();
    const body = (await c.req.json().catch(() => null)) as
      | { role?: unknown; status?: unknown; display_name?: unknown }
      | null;
    const role: Role | undefined =
      body?.role === 'admin' || body?.role === 'member' ? body.role : undefined;
    const status: WhitelistStatus | undefined =
      body?.status === 'active' || body?.status === 'disabled' ? body.status : undefined;
    const me = c.var.principal as { email?: string };
    if (target === me.email && (status === 'disabled' || role === 'member')) {
      return c.json({ error: 'cannot disable or demote yourself' }, 400);
    }
    const displayName = body?.display_name !== undefined ? String(body.display_name) : undefined;
    const updated = await service.store.patch(target, {
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    });
    if (!updated) return c.json({ error: 'entry not found' }, 404);
    return c.json({ entry: updated });
  });

  r.delete('/admin/whitelist/:email', requireAdmin, async (c) => {
    const target = decodeURIComponent(c.req.param('email') ?? '').trim().toLowerCase();
    const me = c.var.principal as { email?: string };
    if (target === me.email) {
      return c.json({ error: 'cannot remove yourself' }, 400);
    }
    const ok = await service.store.remove(target);
    if (!ok) return c.json({ error: 'entry not found' }, 404);
    return c.json({ ok: true });
  });

  return r;
}
