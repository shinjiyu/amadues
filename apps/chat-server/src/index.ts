/**
 * chat-server 入口。
 *
 * 启动流程：
 * 1. 加载 env 配置
 * 2. 初始化 stores（users / threads / uploads）
 * 3. 启动 Hono REST app
 * 4. 在底层 http.Server 上挂 WebSocketServer，path=/ws
 *
 * 进程信号：SIGINT/SIGTERM 优雅关停（关闭 ws、停 http）。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';

import { loadConfig } from './config.js';
import { ensureDirSync } from './store-io.js';
import { UserStore } from './users.js';
import { ThreadStore } from './threads.js';
import { UploadStore } from './uploads.js';
import { WsHub } from './ws-hub.js';
import { buildUsersRouter } from './routes/users.js';
import { buildThreadsRouter } from './routes/threads.js';
import { buildUploadsRouter } from './routes/uploads.js';

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDirSync(config.dataRoot);

  const users = new UserStore({ dataRoot: config.dataRoot });
  const threads = new ThreadStore({
    dataRoot: config.dataRoot,
    globalThreadId: config.globalThreadId,
  });
  const uploads = new UploadStore({ dataRoot: config.dataRoot });

  await users.init();
  await threads.init();
  await uploads.init();

  const hub = new WsHub({
    users,
    threads,
    agentUserIds: config.agentUserIds,
    agentSecret: config.agentSecret,
  });

  const app = new Hono();
  app.use(
    '*',
    cors({
      origin: config.corsOrigin === '*' ? (origin) => origin || '*' : config.corsOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-User-Id', 'Authorization'],
      credentials: true,
    }),
  );

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'chat-server',
      time: new Date().toISOString(),
      global_thread_id: config.globalThreadId,
    }),
  );

  app.route('/', buildUploadsRouter({
    users,
    uploads,
    maxUploadSize: config.maxUploadSize,
  }));
  app.route('/', buildUsersRouter(users));
  app.route('/', buildThreadsRouter({
    users,
    threads,
    uploads,
    hub,
    maxMessagesPerPage: config.maxMessagesPerPage,
  }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error('[chat-server] unhandled error', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  const httpServer = serve(
    { fetch: app.fetch, port: config.port },
    (info) => {
      const reservedAgents = config.agentUserIds.size > 0
        ? `reserved_agents=[${[...config.agentUserIds].join(',')}]`
        : 'reserved_agents=<none>';
      console.log(
        `[chat-server] listening http://localhost:${info.port}  ws://localhost:${info.port}/ws  data=${config.dataRoot}  ${reservedAgents}`,
      );
    },
  ) as ServerType & { on: (ev: string, cb: (...args: unknown[]) => void) => void };

  const wss = new WebSocketServer({ noServer: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (httpServer as any).on('upgrade', (req: any, socket: any, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.handleConnection(ws);
    });
  });

  const shutdown = (signal: string): void => {
    console.log(`[chat-server] ${signal} received, shutting down`);
    wss.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (httpServer as any).close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[chat-server] fatal', e);
  process.exit(1);
});
