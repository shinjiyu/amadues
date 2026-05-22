/**
 * 身份解析中间件 —— REST 请求里读 `X-User-Id` header，必要时 upsert。
 *
 * 无认证：客户端自报。没有 `X-User-Id` 的请求会被 401 拒绝（除非是公开端点，
 * 由路由自己跳过中间件）。
 *
 * `display_name`：
 * - 默认沿用 store 里的现有值
 * - 若 query 带 `?display_name=xxx`，会更新到 store
 * - 若 store 里没记录且 query 也没给，记一个临时名 `user_<userId>`
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
