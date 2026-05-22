/**
 * WebSocket Hub —— 连接管理 + 订阅 + 广播。
 *
 * 设计选择：
 * - 用 `ws` 包的 raw WebSocket 对象（由 `@hono/node-ws` upgrade 中间件交付），
 *   因为我们需要更精细的连接生命周期与广播扇出，而 hono 的高层封装会阻碍这一点。
 * - **未发 hello 不算上线**：连接建立后 30 秒内必须发 `hello`，否则服务端关闭。
 * - 同一 user_id 多 socket（多端登录并存）：在线计数靠 `UserStore.markOnline/Offline`。
 *
 * 广播策略：
 * - presence.update：广播到所有已 hello 的 socket。
 * - message.new：仅扇出到该 thread 的订阅者，且适用 thread 访问权限（DM 仅参与者）。
 */
import type { WebSocket } from 'ws';
import {
  ClientEventSchema,
  type Message,
  type ServerEvent,
  type UserPresence,
} from '@utlra/webchat-protocol';
import type { UserStore } from './users.js';
import type { ThreadStore } from './threads.js';

const HELLO_TIMEOUT_MS = 30_000;

interface ConnectionState {
  ws: WebSocket;
  userId: string | null;
  /** 已订阅的 thread_id 集合 */
  subscriptions: Set<string>;
  helloTimer: NodeJS.Timeout;
}

export interface WsHubOptions {
  users: UserStore;
  threads: ThreadStore;
  /** 保留 user_id 集合：声称这些之一时必须携带 agentSecret */
  agentUserIds: Set<string>;
  agentSecret: string | null;
}

export class WsHub {
  /** 所有活跃连接 */
  private conns = new Set<ConnectionState>();
  /** user_id → 该用户的所有 socket */
  private byUser = new Map<string, Set<ConnectionState>>();

  constructor(private readonly opts: WsHubOptions) {}

  handleConnection(ws: WebSocket): void {
    const state: ConnectionState = {
      ws,
      userId: null,
      subscriptions: new Set(),
      helloTimer: setTimeout(() => {
        if (!state.userId) {
          this.sendError(ws, 'not_authenticated', '30s 内未发送 hello');
          try { ws.close(4001, 'hello timeout'); } catch { /* ignore */ }
        }
      }, HELLO_TIMEOUT_MS),
    };
    this.conns.add(state);

    ws.on('message', (raw) => {
      void this.handleMessage(state, raw.toString('utf-8')).catch((e) => {
        console.error('[chat-server] ws message error', e);
        this.sendError(ws, 'internal', String(e?.message ?? e));
      });
    });

    ws.on('close', () => {
      clearTimeout(state.helloTimer);
      this.conns.delete(state);
      if (state.userId) {
        const bag = this.byUser.get(state.userId);
        if (bag) {
          bag.delete(state);
          if (bag.size === 0) this.byUser.delete(state.userId);
        }
        const wentOffline = this.opts.users.markOffline(state.userId);
        if (wentOffline) {
          const u = this.opts.users.get(state.userId);
          if (u) {
            this.broadcastToAuthed({
              type: 'presence.update',
              user_id: u.user_id,
              display_name: u.display_name,
              online: false,
            });
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.warn('[chat-server] ws error', err);
    });
  }

  private async handleMessage(state: ConnectionState, raw: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.sendError(state.ws, 'invalid_payload', 'JSON parse failed');
      return;
    }
    const parsed = ClientEventSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(state.ws, 'invalid_payload', parsed.error.message);
      return;
    }
    const ev = parsed.data;

    if (ev.type === 'hello') {
      await this.onHello(state, ev.user_id, ev.display_name, ev.agent_secret);
      return;
    }
    if (!state.userId) {
      this.sendError(state.ws, 'not_authenticated', '请先发送 hello');
      return;
    }
    if (ev.type === 'subscribe') {
      this.onSubscribe(state, ev.thread_id);
    } else if (ev.type === 'since') {
      await this.onSince(state, ev.thread_id, ev.cursor);
    } else if (ev.type === 'typing') {
      this.onTyping(state, ev.thread_id);
    }
  }

  private async onHello(
    state: ConnectionState,
    userId: string,
    displayName: string,
    agentSecret: string | undefined,
  ): Promise<void> {
    // agent 保留 user_id 校验：声称是任意保留 user_id 之一 → 必须携带正确 secret
    if (this.opts.agentUserIds.has(userId)) {
      if (!this.opts.agentSecret) {
        this.sendError(state.ws, 'not_authenticated', '服务器未配置 agent secret');
        try { state.ws.close(4003, 'agent secret missing'); } catch { /* ignore */ }
        return;
      }
      if (agentSecret !== this.opts.agentSecret) {
        this.sendError(state.ws, 'not_authenticated', 'agent_secret 不匹配');
        try { state.ws.close(4003, 'agent secret mismatch'); } catch { /* ignore */ }
        return;
      }
    }

    clearTimeout(state.helloTimer);
    await this.opts.users.upsert(userId, displayName);
    state.userId = userId;
    let bag = this.byUser.get(userId);
    if (!bag) {
      bag = new Set();
      this.byUser.set(userId, bag);
    }
    bag.add(state);

    const wentOnline = this.opts.users.markOnline(userId);

    this.send(state.ws, {
      type: 'ready',
      user_id: userId,
      display_name: displayName,
    });

    const presence: UserPresence[] = this.opts.users.listWithPresence();
    this.send(state.ws, { type: 'presence.sync', users: presence });

    if (wentOnline) {
      this.broadcastToAuthed(
        {
          type: 'presence.update',
          user_id: userId,
          display_name: displayName,
          online: true,
        },
        state,
      );
    }
  }

  private onSubscribe(state: ConnectionState, threadId: string): void {
    if (!state.userId) return;
    if (!this.opts.threads.canAccess(threadId, state.userId)) {
      this.sendError(state.ws, 'not_a_participant', `thread ${threadId} 无访问权限`);
      return;
    }
    state.subscriptions.add(threadId);
  }

  private async onSince(
    state: ConnectionState,
    threadId: string,
    cursor: string | null,
  ): Promise<void> {
    if (!state.userId) return;
    if (!this.opts.threads.canAccess(threadId, state.userId)) {
      this.sendError(state.ws, 'not_a_participant', `thread ${threadId} 无访问权限`);
      return;
    }
    // 通过 listMessages 的反向用法：cursor=null 时拉最后一页；cursor=非空时拉之后的消息
    // 这里用「找到 cursor 之后的所有消息」的语义
    const list = await this.opts.threads.listMessages(threadId, undefined, 10_000);
    const all = list.messages;
    let startIdx = 0;
    if (cursor) {
      const idx = all.findIndex((m) => m.id === cursor);
      if (idx >= 0) startIdx = idx + 1;
    }
    for (const m of all.slice(startIdx)) {
      this.send(state.ws, { type: 'message.new', thread_id: threadId, message: m });
    }
  }

  private onTyping(state: ConnectionState, threadId: string): void {
    if (!state.userId) return;
    if (!this.opts.threads.canAccess(threadId, state.userId)) return;
    const payload: ServerEvent = {
      type: 'typing.relay',
      thread_id: threadId,
      user_id: state.userId,
    };
    this.fanoutThread(threadId, payload, state);
  }

  /**
   * 外部入口：REST `POST /threads/:id/messages` 后调用，向所有 thread 订阅者推 `message.new`，
   * 并向发送者本人推 `message.ack`（如果带了 client_msg_id）。
   */
  notifyNewMessage(message: Message, clientMsgId: string | undefined, senderUserId: string): void {
    const event: ServerEvent = {
      type: 'message.new',
      thread_id: message.thread_id,
      message,
    };
    this.fanoutThread(message.thread_id, event);
    if (clientMsgId) {
      const ackEvent: ServerEvent = {
        type: 'message.ack',
        client_msg_id: clientMsgId,
        message_id: message.id,
        thread_id: message.thread_id,
      };
      const bag = this.byUser.get(senderUserId);
      if (bag) {
        for (const conn of bag) this.send(conn.ws, ackEvent);
      }
    }
  }

  /** 向订阅了 threadId 的所有 socket 广播（按 thread 访问权限再次过滤）。 */
  private fanoutThread(threadId: string, event: ServerEvent, except?: ConnectionState): void {
    for (const conn of this.conns) {
      if (conn === except) continue;
      if (!conn.userId) continue;
      if (!conn.subscriptions.has(threadId)) continue;
      if (!this.opts.threads.canAccess(threadId, conn.userId)) continue;
      this.send(conn.ws, event);
    }
  }

  private broadcastToAuthed(event: ServerEvent, except?: ConnectionState): void {
    for (const conn of this.conns) {
      if (conn === except) continue;
      if (!conn.userId) continue;
      this.send(conn.ws, event);
    }
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch (e) {
      console.warn('[chat-server] ws send failed', e);
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { type: 'error', code, message });
  }
}
