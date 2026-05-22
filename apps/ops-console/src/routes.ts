/**
 * Ops 控制台 REST 路由。
 *
 * GET    /api/services                  列表 + 状态
 * POST   /api/services/:id/start
 * POST   /api/services/:id/stop
 * POST   /api/services/:id/restart
 * GET    /api/services/:id/logs?tail=200
 * POST   /api/services/start-all        按依赖顺序顺序启动
 * POST   /api/services/stop-all         全部停止
 */
import type { Hono } from 'hono';
import type { ProcessManager, ServiceRuntime } from './process-manager.js';

interface ServiceDto {
  id: string;
  name: string;
  description: string;
  port: number | null;
  healthUrl: string | null;
  openUrl: string | null;
  dependsOn: string[];
  status: ServiceRuntime['status'];
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  lastHealthOk: number | null;
  lastHealthCheck: number | null;
  externalPid: number | null;
  recentLogTail: { ts: number; stream: string; text: string }[];
}

function toDto(r: ServiceRuntime, recentLogN = 10): ServiceDto {
  return {
    id: r.def.id,
    name: r.def.name,
    description: r.def.description,
    port: r.def.port,
    healthUrl: r.def.healthUrl,
    openUrl: r.def.openUrl,
    dependsOn: r.def.dependsOn,
    status: r.status,
    pid: r.pid,
    startedAt: r.startedAt,
    uptimeMs: r.startedAt != null && r.pid != null ? Date.now() - r.startedAt : null,
    lastExitCode: r.lastExitCode,
    lastExitSignal: r.lastExitSignal,
    lastError: r.lastError,
    lastHealthOk: r.lastHealthOk,
    lastHealthCheck: r.lastHealthCheck,
    externalPid: r.externalPid,
    recentLogTail: r.logs.slice(-recentLogN),
  };
}

export function registerRoutes(app: Hono, pm: ProcessManager): void {
  app.get('/api/services', (c) => {
    const services = pm.list().map((r) => toDto(r));
    return c.json({ services, now: Date.now() });
  });

  app.get('/api/services/:id', (c) => {
    const r = pm.get(c.req.param('id'));
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json({ service: toDto(r, 50) });
  });

  app.post('/api/services/:id/start', (c) => {
    const r = pm.start(c.req.param('id'));
    if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/services/:id/stop', async (c) => {
    const r = await pm.stop(c.req.param('id'));
    if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/services/:id/restart', async (c) => {
    const r = await pm.restart(c.req.param('id'));
    if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
    return c.json({ ok: true });
  });

  app.get('/api/services/:id/logs', (c) => {
    const r = pm.get(c.req.param('id'));
    if (!r) return c.json({ error: 'not found' }, 404);
    const raw = c.req.query('tail') ?? '200';
    const tail = Math.min(1000, Math.max(1, Number(raw) || 200));
    return c.json({ logs: r.logs.slice(-tail) });
  });

  app.post('/api/services/start-all', async (c) => {
    const order = topoSort(pm.list());
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of order) {
      const r = pm.start(id);
      results.push({ id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      // 对依赖型服务：等 200ms 给前置一点起飞时间（健康检查仍在跑）
      await new Promise((res) => setTimeout(res, 200));
    }
    return c.json({ results });
  });

  app.post('/api/services/stop-all', async (c) => {
    const order = topoSort(pm.list()).reverse();
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of order) {
      const r = await pm.stop(id);
      results.push({ id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    }
    return c.json({ results });
  });

  app.get('/api/health', (c) =>
    c.json({ ok: true, service: 'ops-console', count: pm.list().length }),
  );
}

/** 按 dependsOn 拓扑排序；环或缺失依赖按原顺序追加 */
function topoSort(services: ServiceRuntime[]): string[] {
  const ids = new Set(services.map((s) => s.def.id));
  const visited = new Set<string>();
  const result: string[] = [];

  const visit = (id: string, stack: Set<string>) => {
    if (visited.has(id)) return;
    if (stack.has(id)) return; // 环：忽略
    if (!ids.has(id)) return;
    stack.add(id);
    const def = services.find((s) => s.def.id === id)!.def;
    for (const dep of def.dependsOn) visit(dep, stack);
    stack.delete(id);
    visited.add(id);
    result.push(id);
  };

  for (const s of services) visit(s.def.id, new Set());
  return result;
}
