/**
 * F 装配：/api/health 契约（与 index 同源 registerHealthRoute）。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { registerHealthRoute } from '../api/health-route.js';

describe('integration: index HTTP health', () => {
  it('GET /api/health → ok + dataRoot', async () => {
    const app = new Hono();
    const dataRoot = '/tmp/kuroneko-test-data';
    registerHealthRoute(app, dataRoot);

    const res = await app.request('http://test/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dataRoot: string };
    expect(body.ok).toBe(true);
    expect(body.dataRoot).toBe(dataRoot);
  });
});
