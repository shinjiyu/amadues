/**
 * Ops 控制台 HTTP 入口（默认端口 7777）。
 *
 * 启动：从仓库根 `npm run dev:ops` 或 `cd apps/ops-console && npm run dev`
 * 仅监听本地（127.0.0.1）。生产部署不建议暴露公网。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { buildServiceRegistry, resolveRepoRoot } from './service-registry.js';
import { ProcessManager } from './process-manager.js';
import { HealthProbe } from './health-probe.js';
import { registerRoutes } from './routes.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRoot(__dir);

const services = buildServiceRegistry(REPO_ROOT);
const pm = new ProcessManager(services);
const probe = new HealthProbe(pm, 3000);
probe.start();

const app = new Hono();

app.use(
  '/*',
  cors({
    origin: ['http://localhost:7779', 'http://127.0.0.1:7779'],
  }),
);

registerRoutes(app, pm);

// 生产模式静态托管 web/dist（构建后产物）
const WEB_DIST = path.join(__dir, '..', 'web', 'dist');
if (fs.existsSync(WEB_DIST)) {
  app.get('/', (c) => {
    const html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
    return c.html(html);
  });
  app.get('/assets/:file', (c) => {
    const file = c.req.param('file');
    const fp = path.join(WEB_DIST, 'assets', file);
    if (!fs.existsSync(fp)) return c.text('not found', 404);
    const buf = fs.readFileSync(fp);
    const mime = file.endsWith('.css')
      ? 'text/css'
      : file.endsWith('.js')
        ? 'application/javascript'
        : 'application/octet-stream';
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
    });
  });
}

const port = Number(process.env['OPS_CONSOLE_PORT'] ?? 7777);
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(
    `[ops-console] http://127.0.0.1:${info.port}  managing ${services.length} services  repo=${REPO_ROOT}`,
  );
});

const shutdown = async (signal: string) => {
  console.log(`[ops-console] ${signal} received, stopping all spawned services …`);
  probe.stop();
  await pm.dispose();
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 4000).unref();
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ops-console] 端口 ${port} 已占用：换 OPS_CONSOLE_PORT=7778 重启`);
  } else {
    console.error('[ops-console] listen error:', err);
  }
  process.exit(1);
});
