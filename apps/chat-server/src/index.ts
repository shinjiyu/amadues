/**
 * chat-server 入口。
 *
 * 启动流程：
 * 1. 加载 env 配置
 * 2. 初始化 stores（users / threads / uploads）
 * 3. 初始化 AuthStore / AuthService（白名单 + loginserver 客户端）
 * 4. 启动 Hono REST app（先 auth middleware → /auth/* 路由 → 业务路由）
 * 5. 在底层 http.Server 上挂 WebSocketServer，path=/ws，upgrade 先做 ws-auth
 *
 * 进程信号：SIGINT/SIGTERM 优雅关停（关闭 ws、停 http）。
 */
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

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

import { AuthStore } from './auth/store.js';
import { LoginServerClient } from './auth/loginserver.js';
import { AuthService } from './auth/service.js';
import { buildAuthRoutes } from './auth/routes.js';
import { authMiddleware } from './auth/middleware.js';
import { authenticateUpgrade } from './auth/ws-auth.js';

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDirSync(config.dataRoot);
  for (const sub of ['messages', 'uploads'] as const) {
    ensureDirSync(path.join(config.dataRoot, sub));
  }

  const users = new UserStore({ dataRoot: config.dataRoot });
  const threads = new ThreadStore({
    dataRoot: config.dataRoot,
    globalThreadId: config.globalThreadId,
  });
  const uploads = new UploadStore({ dataRoot: config.dataRoot });

  await users.init();
  await threads.init();
  await uploads.init();

  // ── Auth setup ────────────────────────────────────────────────
  const authStore = new AuthStore(config.auth.authDataFile);
  await authStore.load();
  // loginserver client 必有，required=false 时也允许浏览器手动登录（白名单存在即可）
  const loginUrlForClient = config.auth.loginServerUrl ?? 'http://127.0.0.1:0';
  const loginClient = new LoginServerClient(loginUrlForClient);
  const authService = new AuthService(authStore, loginClient, {
    cookieSecure: config.auth.cookieSecure,
    ...(config.auth.cookieDomain ? { cookieDomain: config.auth.cookieDomain } : {}),
  });
  if (config.auth.adminEmails.length > 0) {
    await authService.seedAdmins(config.auth.adminEmails);
  }

  const hub = new WsHub({
    users,
    threads,
    agentUserIds: config.agentUserIds,
    agentSecret: config.agentSecret,
    authRequired: config.auth.required,
  });

  const app = new Hono();

  // CORS：开启 credentials 时不能用 `*`，必须明确 origin
  const corsOrigin =
    config.corsOrigin === '*'
      ? (origin: string) => origin || '*'
      : config.corsOrigin
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
  app.use(
    '*',
    cors({
      origin: typeof corsOrigin === 'function' ? corsOrigin : corsOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-User-Id', 'Authorization'],
      credentials: true,
    }),
  );

  // 健康检查永远公开
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'chat-server',
      time: new Date().toISOString(),
      global_thread_id: config.globalThreadId,
      auth_required: config.auth.required,
    }),
  );

  // 鉴权中间件：不强制 401（required 为 false 时 anonymous 也放行；
  // 业务路由内部的 identityMiddleware + Hono routes 自己决定）
  // 实际拦截放到 identityMiddleware：人类无 cookie & 无 X-User-Id → 401
  // 这样 /auth/login 自身也能走通（auth middleware 不会因 anonymous 而 401）
  app.use(
    '*',
    authMiddleware({
      service: authService,
      users,
      agentUserIds: config.agentUserIds,
      agentSecret: config.agentSecret,
      required: false,
    }),
  );

  // /auth/* + /admin/whitelist/*
  app.route('/', buildAuthRoutes(authService, {
    loginPageUrl: config.auth.loginPageUrl,
    returnParam: config.auth.loginReturnParam,
    tokenStorageKey: config.auth.loginTokenStorageKey,
    refreshStorageKey: config.auth.loginRefreshStorageKey,
    userStorageKey: config.auth.loginUserStorageKey,
    logoutPageUrl: config.auth.logoutPageUrl,
  }));

  app.route('/', buildUploadsRouter({
    users,
    uploads,
    maxUploadSize: config.maxUploadSize,
    publicBasePath: config.publicBasePath,
  }));
  app.route('/', buildUsersRouter(users));
  app.route('/', buildThreadsRouter({
    users,
    threads,
    uploads,
    hub,
    maxMessagesPerPage: config.maxMessagesPerPage,
    publicBasePath: config.publicBasePath,
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
      const reservedAgents = config.agentSecret
        ? `agent_bypass=secret${config.agentUserIds.size > 0 ? ` allowlist=[${[...config.agentUserIds].join(',')}]` : ' (any user_id)'}`
        : 'agent_bypass=<none>';
      const authState = config.auth.required
        ? `auth=required loginserver=${config.auth.loginServerUrl}`
        : 'auth=optional';
      console.log(
        `[chat-server] listening http://localhost:${info.port}  ws://localhost:${info.port}/ws  data=${config.dataRoot}  ${reservedAgents}  ${authState}`,
      );
    },
  ) as ServerType & { on: (ev: string, cb: (...args: unknown[]) => void) => void };

  const wss = new WebSocketServer({ noServer: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (httpServer as any).on('upgrade', async (req: IncomingMessage, socket: any, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    let principal;
    try {
      principal = await authenticateUpgrade(req, {
        service: authService,
        agentUserIds: config.agentUserIds,
        agentSecret: config.agentSecret,
      });
    } catch (e) {
      console.warn('[chat-server] upgrade auth failed', (e as Error).message);
      principal = { kind: 'anonymous' as const };
    }
    if (config.auth.required && principal.kind === 'anonymous') {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      } catch { /* ignore */ }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.handleConnection(ws, principal);
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
