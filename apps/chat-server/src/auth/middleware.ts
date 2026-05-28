/**
 * Hono 中间件 —— 把 Principal 注入 `c.var.principal`，并把 user_id/display_name 同步到既有 ContextVariableMap。
 *
 * 解析顺序：
 *   1. `Authorization: Bearer <WEBCHAT_AGENT_SECRET>` + `X-User-Id` 命中保留 agent → AgentPrincipal
 *   2. Cookie (`wc_token` / `wc_refresh`) → UserPrincipal（必要时刷新 access cookie）
 *   3. 否则 anonymous（路由可自行决定是否 401）
 *
 * 关键安全约束：**不再相信任何客户端自报的 `X-User-Id`**（除非走 agent secret 旁路）。
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { UserStore } from '../users.js';
import { setAuthCookiesHono, isHonoRequestSecure } from './cookies.js';
import type { AuthService } from './service.js';
import type { Principal } from './types.js';

declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal;
  }
}

export interface AuthMiddlewareOptions {
  service: AuthService;
  users: UserStore;
  agentUserIds: ReadonlySet<string>;
  agentSecret: string | null;
  /** true 时 anonymous 直接 401；false 时仍 next() 但 principal=anonymous。 */
  required: boolean;
}

export function authMiddleware(opts: AuthMiddlewareOptions) {
  const { service, users, agentUserIds, agentSecret, required } = opts;

  return async (c: Context, next: Next): Promise<void | Response> => {
    let principal: Principal = { kind: 'anonymous' };

    // ── 1) Agent secret 旁路 ───────────────────────────────────────
    const auth = c.req.header('authorization');
    const claimedUserId = c.req.header('x-user-id')?.trim();
    if (
      agentSecret &&
      auth &&
      claimedUserId &&
      auth.toLowerCase().startsWith('bearer ') &&
      auth.slice(7).trim() === agentSecret &&
      agentUserIds.has(claimedUserId)
    ) {
      principal = { kind: 'agent', userId: claimedUserId };
      const queryName = c.req.query('display_name')?.trim();
      const existing = users.get(claimedUserId);
      const displayName = queryName || existing?.display_name || claimedUserId;
      await users.upsert(claimedUserId, displayName);
      c.set('principal', principal);
      c.set('userId', claimedUserId);
      c.set('displayName', displayName);
      await next();
      return;
    }

    // ── 2) Cookie 用户 ────────────────────────────────────────────
    try {
      const cookies = parseCookieHeader(c.req.header('cookie'));
      const r = await service.authenticateFromCookies(cookies);
      if (r.newAccessToken) {
        setAuthCookiesHono(
          c,
          { access: r.newAccessToken },
          service.cookieOptsFor(isHonoRequestSecure(c)),
        );
      }
      if (r.principal) {
        principal = r.principal;
        try {
          await users.upsert(r.principal.userId, r.principal.displayName);
        } catch (e) {
          console.warn('[chat-server][auth] users.upsert failed:', (e as Error).message);
        }
        c.set('principal', principal);
        c.set('userId', r.principal.userId);
        c.set('displayName', r.principal.displayName);
        await next();
        return;
      }
    } catch (e) {
      console.warn('[chat-server][auth] authenticateFromCookies failed:', (e as Error).message);
    }

    // ── 3) Anonymous ───────────────────────────────────────────────
    if (required) {
      throw new HTTPException(401, { message: 'authentication required' });
    }
    c.set('principal', principal);
    await next();
  };
}

/** 要求当前请求至少是已登录用户（或 agent）。 */
export function requireAuthed(c: Context, next: Next): Promise<void | Response> | Response {
  const p = c.var.principal;
  if (!p || p.kind === 'anonymous') {
    return c.json({ error: 'authentication required' }, 401);
  }
  return next();
}

/** 仅 admin 用户可用（agent 不算 admin）。 */
export function requireAdmin(c: Context, next: Next): Promise<void | Response> | Response {
  const p = c.var.principal;
  if (!p || p.kind !== 'user' || p.role !== 'admin') {
    return c.json({ error: 'admin role required' }, 403);
  }
  return next();
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
