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
 * - message.new / typing / cleared：
 *   - **大群**：仅扇出到已 subscribe 的 socket（需客户端主动订阅）。
 *   - **DM**：扇出到所有在线且 canAccess 的参与者（无需先 subscribe；收到后自动 subscribe，
 *     以便 agent bridge 在用户新建私聊后仍能收到首条消息）。
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
import type { Principal } from './auth/types.js';

const HELLO_TIMEOUT_MS = 30_000;

interface ConnectionState {
  ws: WebSocket;
  userId: string | null;
  /**
   * 来自 upgrade 阶段的鉴权结果（cookie / agent secret）。
   * - `kind: 'user'` → hello 必须与这里的 user_id 一致（display_name 以白名单为准）
   * - `kind: 'agent'` → hello 必须命中保留 agent，且 user_id 一致
   * - `kind: 'anonymous'` → 兼容旧模式（dev/required=false）；hub 视配置接受或拒绝
   */
  principal: Principal;
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
  /** 公网模式：anonymous upgrade 直接拒绝 hello。默认 false（兼容 e2e/dev）。 */
  authRequired?: boolean;
}

export class WsHub {
  /** 所有活跃连接 */
  private conns = new Set<ConnectionState>();
  /** user_id → 该用户的所有 socket */
  private byUser = new Map<string, Set<ConnectionState>>();

  constructor(private readonly opts: WsHubOptions) {}

  handleConnection(ws: WebSocket, principal: Principal = { kind: 'anonymous' }): void {
    const state: ConnectionState = {
      ws,
      userId: null,
      principal,
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
    // 浏览器端应用层空串保活（agent 用协议层 ping，由 ws 自动 pong，不进 message）
    if (!raw.trim()) return;

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
      this.onTyping(state, ev.thread_id, ev.state ?? 'start');
    }
  }

  private async onHello(
    state: ConnectionState,
    userId: string,
    displayName: string,
    agentSecret: string | undefined,
  ): Promise<void> {
    // ── 1) 已登录人类用户（upgrade 阶段 cookie 已验过）─────────────
    if (state.principal.kind === 'user') {
      const p = state.principal;
      // hello 里 user_id 必须等于 cookie 解出的 user_id，否则视为冒名
      if (userId !== p.userId) {
        this.sendError(state.ws, 'not_authenticated', 'hello user_id 与登录态不一致');
        try { state.ws.close(4003, 'hello user_id mismatch'); } catch { /* ignore */ }
        return;
      }
      // display_name 以服务端为准（前端可能传昵称，这里强制覆盖到白名单值）
      displayName = p.displayName || displayName;
    } else if (state.principal.kind === 'agent') {
      // Upgrade 阶段已通过 Bearer secret 验证；hello 里允许直接绑定 agent user_id，
      // 也允许带 agent_secret（与现有 bridge 兼容），但只信 upgrade 阶段的认证。
      if (userId !== state.principal.userId) {
        this.sendError(state.ws, 'not_authenticated', 'hello user_id 与 agent 凭证不一致');
        try { state.ws.close(4003, 'hello user_id mismatch'); } catch { /* ignore */ }
        return;
      }
    } else {
      // ── 2) Anonymous upgrade（无 cookie，且非 agent Bearer）─────
      if (this.opts.authRequired) {
        this.sendError(state.ws, 'not_authenticated', '未登录');
        try { state.ws.close(4401, 'login required'); } catch { /* ignore */ }
        return;
      }
      // 开发态兼容：
      // - hello 显式带了 agent_secret → 必须匹配（agent 登录，任意 user_id）
      // - 未带 secret 但 user_id 命中可选白名单 → 拒绝（防 dev 冒充已知名称）
      // - 其余 → 旧版开放 dev（任意 user_id，无 secret）
      if (agentSecret !== undefined && agentSecret !== '') {
        if (!this.opts.agentSecret || agentSecret !== this.opts.agentSecret) {
          this.sendError(state.ws, 'not_authenticated', 'agent_secret 不匹配');
          try { state.ws.close(4003, 'agent secret mismatch'); } catch { /* ignore */ }
          return;
        }
      } else if (this.opts.agentUserIds.size > 0 && this.opts.agentUserIds.has(userId)) {
        this.sendError(state.ws, 'not_authenticated', '保留 agent user_id 需携带 agent_secret');
        try { state.ws.close(4003, 'agent secret required'); } catch { /* ignore */ }
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

  private onTyping(
    state: ConnectionState,
    threadId: string,
    typingState: 'start' | 'stop',
  ): void {
    if (!state.userId) return;
    this.relayTyping(threadId, state.userId, typingState, state);
  }

  /**
   * 外部入口：把某 user 的输入活动扇出给线程订阅者（不含发起者本人）。
   *
   * 既给 WS `typing` 事件用，也给 REST `POST /threads/:id/typing`（agent 链路）用——
   * agent 走 REST + bridge，没有浏览器那种 ws `typing` 通路，靠此方法广播
   * 「Shiro 正在输入…」。typing 是**瞬时信号**，不落库、不进历史。
   */
  relayTyping(
    threadId: string,
    userId: string,
    typingState: 'start' | 'stop',
    except?: ConnectionState,
  ): void {
    if (!this.opts.threads.canAccess(threadId, userId)) return;
    const displayName = this.opts.users.get(userId)?.display_name;
    const payload: ServerEvent = {
      type: 'typing.relay',
      thread_id: threadId,
      user_id: userId,
      state: typingState,
      ...(displayName ? { display_name: displayName } : {}),
    };
    this.fanoutThread(threadId, payload, except);
  }

  /**
   * 外部入口：REST `POST /threads/:id/messages` 后调用，向所有 thread 订阅者推 `message.new`，
   * 并向发送者本人推 `message.ack`（如果带了 client_msg_id）。
   */
  notifyMessagesCleared(threadId: string, clearedByUserId: string, deletedCount: number): void {
    this.fanoutThread(threadId, {
      type: 'messages.cleared',
      thread_id: threadId,
      cleared_by_user_id: clearedByUserId,
      deleted_count: deletedCount,
    });
  }

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

  /** 向 thread 相关 socket 广播（大群需 subscribe；DM 推给全部在线参与者）。 */
  private fanoutThread(threadId: string, event: ServerEvent, except?: ConnectionState): void {
    const thread = this.opts.threads.get(threadId);
    const isDm = thread?.kind === 'dm';
    for (const conn of this.conns) {
      if (conn === except) continue;
      if (!conn.userId) continue;
      if (!this.opts.threads.canAccess(threadId, conn.userId)) continue;
      if (!isDm && !conn.subscriptions.has(threadId)) continue;
      this.send(conn.ws, event);
      if (isDm) {
        conn.subscriptions.add(threadId);
      }
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
