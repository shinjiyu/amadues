/**
 * HTTP 健康检查路由（与 index.ts 契约一致，供装配测引用）。
 */
import type { Hono } from 'hono';

export function registerHealthRoute(app: Hono, dataRoot: string): void {
  app.get('/api/health', (c) => c.json({ ok: true, dataRoot }));
}
