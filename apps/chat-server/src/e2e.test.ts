/**
 * 端到端集成测试 —— §9 验收六条的可重复跑版本。
 *
 * 流程（全部在 vitest 进程内）：
 * 1. 启动 chat-server（独立 http + ws 端口）
 * 2. 两个 ws 客户端（alice / bob）连入
 * 3. 大群互发 + 历史拉取（§9.2）
 * 4. 第三方读 DM 拒绝（§9.3）
 * 5. @ mention 结构化存储（§9.4）
 * 6. 引用回复（§9.5）
 * 7. WebChatChannel（适配器）模拟 agent，收到 @agent 后回一句（§9.6 简化版）
 *
 * 不需要真启动 Kuroneko 进程；WebChatChannel 直接 import 调用，验证 ChatIRChannel 契约。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { serve, type ServerType } from '@hono/node-server';
import {
  ChatAssetStore,
  IdentityRegistry,
  type ChatIRChannel,
  type ChatIRInboundEvent,
  ChatIRSeenTracker,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import type { ServerEvent } from '@utlra/webchat-protocol';
import { WebChatChannel } from '@utlra/webchat-bridge';
import { UserStore } from './users.js';
import { ThreadStore } from './threads.js';
import { UploadStore } from './uploads.js';
import { WsHub } from './ws-hub.js';
import { buildUsersRouter } from './routes/users.js';
import { buildThreadsRouter } from './routes/threads.js';
import { buildUploadsRouter } from './routes/uploads.js';

interface ServerHandle {
  port: number;
  dataRoot: string;
  stop: () => Promise<void>;
}

async function startChatServer(opts: { agentUserId?: string; agentSecret?: string } = {}): Promise<ServerHandle> {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webchat-e2e-'));
  const users = new UserStore({ dataRoot });
  const threads = new ThreadStore({ dataRoot, globalThreadId: 'global' });
  const uploads = new UploadStore({ dataRoot });
  await users.init();
  await threads.init();
  await uploads.init();
  const hub = new WsHub({
    users,
    threads,
    agentUserIds: opts.agentUserId ? new Set([opts.agentUserId]) : new Set(),
    agentSecret: opts.agentSecret ?? null,
  });
  const app = new Hono();
  app.use('*', cors({ origin: '*' }));
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/', buildUploadsRouter({ users, uploads, maxUploadSize: 1024 * 1024 }));
  app.route('/', buildUsersRouter(users));
  app.route('/', buildThreadsRouter({ users, threads, uploads, hub, maxMessagesPerPage: 200 }));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error('test server', err);
    return c.json({ error: 'internal' }, 500);
  });

  const port = await pickPort();
  let httpServer: (ServerType & { on: (ev: string, cb: (...args: unknown[]) => void) => void; close: (cb?: () => void) => void }) | null = null;
  const wss = new WebSocketServer({ noServer: true });
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve()) as ServerType & {
      on: (ev: string, cb: (...args: unknown[]) => void) => void;
      close: (cb?: () => void) => void;
    };
    httpServer.on('upgrade', (req: unknown, socket: unknown, head: unknown) => {
      const r = req as { url?: string };
      const url = new URL(r.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        (socket as { destroy: () => void }).destroy();
        return;
      }
      wss.handleUpgrade(r as never, socket as never, head as never, (ws) => {
        hub.handleConnection(ws);
      });
    });
  });

  const handle: ServerHandle = {
    port,
    dataRoot,
    stop: async () => {
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      const srv = httpServer as null | (ServerType & {
        closeAllConnections?: () => void;
        close: (cb?: () => void) => void;
      });
      try { srv?.closeAllConnections?.(); } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        if (!srv) return resolve();
        srv.close(() => resolve());
      });
      try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
  return handle;
}

let nextPort = 19000 + Math.floor(Math.random() * 1000);
function pickPort(): Promise<number> {
  return Promise.resolve(nextPort++);
}

async function rest(port: number, userId: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'X-User-Id': userId,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch { parsed = txt; }
  return { status: res.status, body: parsed };
}

interface TestClient {
  ws: WebSocket;
  events: ServerEvent[];
  waitFor: (predicate: (ev: ServerEvent) => boolean, timeoutMs?: number) => Promise<ServerEvent>;
  close: () => void;
}

async function connectClient(port: number, userId: string, displayName: string): Promise<TestClient> {
  return connectClientWithHello(port, { user_id: userId, display_name: displayName });
}

async function connectClientWithHello(
  port: number,
  hello: { user_id: string; display_name: string; agent_secret?: string },
): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: ServerEvent[] = [];
  const listeners = new Set<(ev: ServerEvent) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      const ev = JSON.parse(raw.toString('utf-8')) as ServerEvent;
      events.push(ev);
      for (const l of listeners) l(ev);
    } catch { /* ignore */ }
  });
  ws.send(JSON.stringify({ type: 'hello', ...hello }));
  // wait for ready
  await new Promise<void>((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error('hello ack timeout')), 5000);
    const l = (ev: ServerEvent): void => {
      if (ev.type === 'ready') {
        clearTimeout(tid);
        listeners.delete(l);
        resolve();
      }
    };
    listeners.add(l);
  });
  return {
    ws,
    events,
    waitFor: (predicate, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        for (const ev of events) {
          if (predicate(ev)) return resolve(ev);
        }
        const tid = setTimeout(() => {
          listeners.delete(l);
          reject(new Error('waitFor timeout'));
        }, timeoutMs);
        const l = (ev: ServerEvent): void => {
          if (predicate(ev)) {
            clearTimeout(tid);
            listeners.delete(l);
            resolve(ev);
          }
        };
        listeners.add(l);
      }),
    close: () => ws.close(),
  };
}

describe('WebChat e2e — §9 验收', () => {
  let srv: ServerHandle;
  beforeEach(async () => {
    srv = await startChatServer({ agentUserId: 'agent', agentSecret: 'shh' });
  });
  afterEach(async () => {
    await srv.stop();
  });

  it('§9.1 两 H5 在线列表上下线', async () => {
    const alice = await connectClient(srv.port, 'alice', 'Alice');
    const bob = await connectClient(srv.port, 'bob', 'Bob');
    await alice.waitFor((ev) => ev.type === 'presence.update' && ev.user_id === 'bob' && ev.online);
    bob.close();
    await alice.waitFor((ev) => ev.type === 'presence.update' && ev.user_id === 'bob' && !ev.online);
    alice.close();
  });

  it('§9.2 大群文字互发 + 历史持久化', async () => {
    const alice = await connectClient(srv.port, 'alice', 'Alice');
    const bob = await connectClient(srv.port, 'bob', 'Bob');
    alice.ws.send(JSON.stringify({ type: 'subscribe', thread_id: 'global' }));
    bob.ws.send(JSON.stringify({ type: 'subscribe', thread_id: 'global' }));
    await new Promise((r) => setTimeout(r, 100));
    const post = await rest(srv.port, 'alice', 'POST', '/threads/global/messages', { text: 'hello bob' });
    expect(post.status).toBe(200);
    await bob.waitFor(
      (ev) => ev.type === 'message.new' && ev.thread_id === 'global' && ev.message.text === 'hello bob',
    );
    const hist = await rest(srv.port, 'bob', 'GET', '/threads/global/messages?limit=5');
    expect(hist.status).toBe(200);
    const histBody = hist.body as { messages: Array<{ text: string }> };
    expect(histBody.messages[histBody.messages.length - 1]?.text).toBe('hello bob');
    alice.close();
    bob.close();
  });

  it('§9.3 第三方读 DM 应被拒绝', async () => {
    const alice = await connectClient(srv.port, 'alice', 'Alice');
    const bob = await connectClient(srv.port, 'bob', 'Bob');
    const charlie = await connectClient(srv.port, 'charlie', 'Charlie');
    await rest(srv.port, 'alice', 'POST', '/threads/dm', { peer_user_id: 'bob' });
    const post = await rest(srv.port, 'alice', 'POST', '/threads/dm:alice:bob/messages', { text: 'secret' });
    expect(post.status).toBe(200);
    const peek = await rest(srv.port, 'charlie', 'GET', '/threads/dm:alice:bob/messages');
    expect(peek.status).toBe(403);
    // 即使 charlie 订阅也收不到
    charlie.ws.send(JSON.stringify({ type: 'subscribe', thread_id: 'dm:alice:bob' }));
    await new Promise((r) => setTimeout(r, 100));
    const errEvent = charlie.events.find(
      (ev) => ev.type === 'error' && ev.code === 'not_a_participant',
    );
    expect(errEvent).toBeDefined();
    alice.close();
    bob.close();
    charlie.close();
  });

  it('§9.3b DM 推送给在线 agent 参与者（无需先 subscribe）', async () => {
    const agent = await connectClientWithHello(srv.port, {
      user_id: 'agent',
      display_name: 'Kuroneko',
      agent_secret: 'shh',
    });
    // 故意不 subscribe dm 线程
    agent.ws.send(JSON.stringify({ type: 'subscribe', thread_id: 'global' }));
    await new Promise((r) => setTimeout(r, 100));

    await connectClient(srv.port, 'alice', 'Alice');
    const dmRes = await rest(srv.port, 'alice', 'POST', '/threads/dm', { peer_user_id: 'agent' });
    expect(dmRes.status).toBe(200);
    const threadId = (dmRes.body as { thread: { id: string } }).thread.id;
    const post = await rest(srv.port, 'alice', 'POST', `/threads/${threadId}/messages`, {
      text: 'dm without subscribe',
    });
    expect(post.status).toBe(200);

    const ev = await agent.waitFor(
      (e) =>
        e.type === 'message.new' &&
        e.thread_id === threadId &&
        e.message.text === 'dm without subscribe',
      3000,
    );
    expect(ev.type).toBe('message.new');
    agent.close();
  });

  it('§9.4 @ mention 持久化为结构化 part', async () => {
    await connectClient(srv.port, 'alice', 'Alice');
    await connectClient(srv.port, 'bob', 'Bob');
    const post = await rest(srv.port, 'alice', 'POST', '/threads/global/messages', {
      text: 'hi @Bob',
      mention_user_ids: ['bob'],
    });
    const body = post.body as {
      message: {
        mentions: Array<{ user_id: string; display_name: string }>;
        parts: Array<{ type: string }>;
      };
    };
    expect(body.message.mentions).toEqual([{ user_id: 'bob', display_name: 'Bob' }]);
    expect(body.message.parts.some((p) => p.type === 'mention')).toBe(true);
  });

  it('§9.5 引用回复链可追溯', async () => {
    await connectClient(srv.port, 'alice', 'Alice');
    const first = await rest(srv.port, 'alice', 'POST', '/threads/global/messages', { text: 'first' });
    const firstId = (first.body as { message: { id: string } }).message.id;
    const second = await rest(srv.port, 'alice', 'POST', '/threads/global/messages', {
      text: 'reply',
      reply_to_message_id: firstId,
    });
    const sec = (second.body as { message: { id: string; reply_to_message_id?: string } }).message;
    expect(sec.reply_to_message_id).toBe(firstId);
    // reply 到不存在的消息应当 404
    const bad = await rest(srv.port, 'alice', 'POST', '/threads/global/messages', {
      text: 'oops',
      reply_to_message_id: 'nonexistent',
    });
    expect(bad.status).toBe(404);
  });

  it('GET /uploads/:asset_id 无需 X-User-Id（Markdown 预览 / img src）', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['# hello\n\npreview'], { type: 'text/markdown' }), 'note.md');
    const up = await fetch(`http://127.0.0.1:${srv.port}/uploads`, {
      method: 'POST',
      headers: { 'X-User-Id': 'alice' },
      body: fd,
    });
    expect(up.status).toBe(200);
    const meta = (await up.json()) as { asset_id: string };
    const got = await fetch(`http://127.0.0.1:${srv.port}/uploads/${meta.asset_id}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toContain('# hello');
  });

  it('§9.6 WebChatChannel 适配器：agent 收到 human 消息并能回复（与 Discord 模式等价）', async () => {
    // 准备 IR 侧资源
    const irRoot = mkdtempSync(path.join(tmpdir(), 'webchat-e2e-ir-'));
    const identityFile = path.join(irRoot, 'identities.json');
    const registry = new IdentityRegistry(identityFile);
    const assetStore = new ChatAssetStore(path.join(irRoot, 'uploads'));
    const threadsFile = path.join(irRoot, 'threads.json');
    const loadThreads = (): LooseThreadStore => {
      try {
        return JSON.parse(fs.readFileSync(threadsFile, 'utf-8'));
      } catch {
        return { threads: [], messages: {} };
      }
    };
    const saveThreads = (data: LooseThreadStore): void => {
      fs.writeFileSync(threadsFile, JSON.stringify(data, null, 2));
    };
    const agentSid = 'idp:agent:assistant';
    const seenTracker = new ChatIRSeenTracker({
      selfAgentSid: agentSid,
      identityRegistry: registry,
    });

    const inboundEvents: ChatIRInboundEvent[] = [];
    const channel: ChatIRChannel = new WebChatChannel({
      config: {
        apiBase: `http://127.0.0.1:${srv.port}`,
        wsUrl: `ws://127.0.0.1:${srv.port}/ws`,
        agentUserId: 'agent',
        agentDisplayName: 'Kuroneko',
        agentSecret: 'shh',
        globalThreadId: 'global',
        mirrorAssets: false,
        tenant: 'default',
        peerAgentUserIds: new Set<string>(),
      },
      agentSid,
      dataRoot: irRoot,
      registry,
      assetStore,
      loadThreads,
      saveThreads,
      seenTracker,
      onAgentMessage: async (ev) => {
        inboundEvents.push(ev);
      },
    });
    channel.start();

    // 等 WS 连上并 ready
    await new Promise((r) => setTimeout(r, 300));

    // human alice 通过 chat-server 直接发 @agent
    const alice = await connectClient(srv.port, 'alice', 'Alice');
    alice.ws.send(JSON.stringify({ type: 'subscribe', thread_id: 'global' }));
    await new Promise((r) => setTimeout(r, 100));

    const post = await rest(srv.port, 'alice', 'POST', '/threads/global/messages', {
      text: 'hi @Kuroneko, help me',
      mention_user_ids: ['agent'],
    });
    expect(post.status).toBe(200);

    // WebChatChannel 应触发 onAgentMessage
    await new Promise<void>((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error('onAgentMessage timeout')), 3000);
      const itv = setInterval(() => {
        if (inboundEvents.length > 0) {
          clearTimeout(tid);
          clearInterval(itv);
          resolve();
        }
      }, 50);
    });

    expect(inboundEvents).toHaveLength(1);
    const ev = inboundEvents[0]!;
    expect(ev.threadId).toBe('webchat:global');
    expect(ev.senderSid).toBe('webchat:user:alice');
    expect(ev.message.message_id.startsWith('webchat:')).toBe(true);
    // @agent 在 IR 中映射为 agentSid（非 webchat:user:agent），与 Discord 通道一致
    expect(
      ev.message.parts.some(
        (p) => p.type === 'mention' && (p as { target_sid?: string }).target_sid === agentSid,
      ),
    ).toBe(true);

    // agent 通过 channel.postMessage 回复
    await channel.postMessage('webchat:global', {
      sender_sid: agentSid,
      text: 'hello, I am here',
    });

    // alice 应当从 WS 收到 message.new（sender 是 agent）
    const replyEv = await alice.waitFor(
      (e) => e.type === 'message.new' && e.thread_id === 'global' && e.message.sender_user_id === 'agent',
      3000,
    );
    expect(replyEv.type).toBe('message.new');

    // IR threads.json 应当持久化了出站消息
    const store = loadThreads();
    expect(store.threads.some((t) => (t as { thread_id: string }).thread_id === 'webchat:global')).toBe(true);
    const msgs = store.messages['webchat:global'] ?? [];
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const lastMsg = msgs[msgs.length - 1] as { sender_sid: string; parts: Array<{ type: string; text?: string }> };
    expect(lastMsg.sender_sid).toBe(agentSid);
    expect(lastMsg.parts.find((p) => p.type === 'text')?.text).toBe('hello, I am here');

    channel.destroy();
    alice.close();
    try { rmSync(irRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
