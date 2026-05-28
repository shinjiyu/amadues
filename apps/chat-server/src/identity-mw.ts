/**
 * 身份解析中间件（已与 auth middleware 协作的兼容层）。
 *
 * 历史背景：M1 时 chat-server 无认证，直接读 `X-User-Id` header。
 * 现在 auth middleware（`auth/middleware.ts`）在更外层把 cookie/secret 解析后已经写好
 * `c.var.userId` / `c.var.displayName` / `c.var.principal`。本中间件成为兜底层：
 *
 * - 若 auth middleware 已注入 `userId` → 直接 `next()`
 * - 否则：旧路径（开发态、未启用 auth 时）退化为读 `X-User-Id`
 *
 * 公网部署务必把 `WEBCHAT_AUTH_REQUIRED=1`，auth middleware 在 anonymous 时会先 401，
 * 这条兜底逻辑永远不会触达「无 header 401」分支。
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { UserStore } from './users.js';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    displayName: string;
  }
}

export function identityMiddleware(users: UserStore) {
  return async (c: Context, next: Next): Promise<void | Response> => {
    if (c.var.userId) {
      await next();
      return;
    }
    // 兜底：旧的「客户端自报」开发路径
    const userId = c.req.header('x-user-id')?.trim();
    if (!userId) {
      throw new HTTPException(401, {
        message: 'missing X-User-Id header (no auth, but identity is required)',
      });
    }
    const queryName = c.req.query('display_name')?.trim();
    const existing = users.get(userId);
    const displayName = queryName || existing?.display_name || `user_${userId}`;
    await users.upsert(userId, displayName);
    c.set('userId', userId);
    c.set('displayName', displayName);
    await next();
  };
}
