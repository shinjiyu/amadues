/**
 * Node 端 WS 客户端 —— 自动重连 + hello + subscribe。
 *
 * 与浏览器版 `apps/web-chat/src/ws.ts` 形态一致，但用 npm `ws` 包。
 */
import { WebSocket as NodeWebSocket } from 'ws';
import { ClientEventSchema, ServerEventSchema, type ClientEvent, type ServerEvent } from '@utlra/webchat-protocol';

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const HELLO_TIMEOUT_MS = 15_000;
/** 经 nginx/运营商 idle 断连时保活；连续 2 次无 pong 则 terminate 触发重连 */
const WS_PING_INTERVAL_MS = 25_000;
const WS_PING_MISS_LIMIT = 2;

function wsLog(userId: string, msg: string, extra?: Record<string, unknown>): void {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[webchat-bridge:ws] ${new Date().toISOString()} agent=${userId} ${msg}${suffix}`);
}

function wsWarn(userId: string, msg: string, extra?: Record<string, unknown>): void {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.warn(`[webchat-bridge:ws] ${new Date().toISOString()} agent=${userId} ${msg}${suffix}`);
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface WebChatWsOptions {
  url: string;
  userId: string;
  displayName: string;
  agentSecret: string | null;
  /** 重新发送 hello 之后需要再次订阅的 thread_id 列表（含可选的 last cursor） */
  getResubscriptions: () => Array<{ threadId: string; cursor: string | null }>;
  onEvent: (ev: ServerEvent) => void;
  onStatusChange?: (s: ConnectionStatus) => void;
}

export class WebChatWsClient {
  private ws: NodeWebSocket | null = null;
  private closed = false;
  private retryIdx = 0;
  private status: ConnectionStatus = 'idle';
  private helloAckTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingMissStreak = 0;
  private isReady = false;
  private socketOpenedAt: number | null = null;

  constructor(private readonly opts: WebChatWsOptions) {}

  connect(): void {
    if (this.ws && (this.status === 'open' || this.status === 'connecting')) {
      wsLog(this.opts.userId, 'connect skipped (already active)', { status: this.status, ready: this.isReady });
      return;
    }
    this.closed = false;
    wsLog(this.opts.userId, 'connect invoked', { url: this.opts.url, reconnectAttempt: this.retryIdx });
    this.openSocket();
  }

  /** 强制断开并走重连（用于 presence 漂移 / 半开连接） */
  reconnectNow(reason: string): void {
    if (this.closed) return;
    wsWarn(this.opts.userId, 'reconnectNow', { reason, wasReady: this.isReady, status: this.status });
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer);
      this.helloAckTimer = null;
    }
    this.clearPingTimer();
    this.isReady = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        this.scheduleReconnect(reason);
        return;
      }
      // 半开连接有时 terminate 后收不到 close；兜底强制重连
      setTimeout(() => {
        if (!this.closed && !this.ws) this.scheduleReconnect(`${reason}:terminate_fallback`);
      }, 2000);
      return;
    }
    this.scheduleReconnect(reason);
  }

  close(): void {
    wsLog(this.opts.userId, 'close invoked (intentional shutdown)', { wasReady: this.isReady, status: this.status });
    this.closed = true;
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer);
      this.helloAckTimer = null;
    }
    this.clearPingTimer();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.setStatus('closed');
  }

  send(ev: ClientEvent): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== NodeWebSocket.OPEN) return;
    const parsed = ClientEventSchema.safeParse(ev);
    if (!parsed.success) {
      wsWarn(this.opts.userId, 'outbound event invalid', { error: parsed.error.message });
      return;
    }
    try {
      ws.send(JSON.stringify(ev));
    } catch (e) {
      wsWarn(this.opts.userId, 'ws send failed', { error: String(e) });
    }
  }

  isOpen(): boolean {
    return this.status === 'open' && this.isReady;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getIsReady(): boolean {
    return this.isReady;
  }

  private openSocket(): void {
    this.setStatus('connecting');
    this.isReady = false;
    this.socketOpenedAt = null;
    const attempt = this.retryIdx + 1;
    wsLog(this.opts.userId, 'connecting', { url: this.opts.url, attempt });
    let ws: NodeWebSocket;
    try {
      // Node ws 支持在 upgrade 握手时携带自定义 header；
      // 这是 chat-server 在 WEBCHAT_AUTH_REQUIRED=1 下让 agent 绕过 cookie 鉴权的唯一办法
      // （浏览器的 WebSocket API 无法 set header，所以浏览器走 cookie 路径）。
      const upgradeHeaders: Record<string, string> = {
        'X-User-Id': this.opts.userId,
      };
      if (this.opts.agentSecret) {
        upgradeHeaders['Authorization'] = `Bearer ${this.opts.agentSecret}`;
      }
      ws = new NodeWebSocket(this.opts.url, { headers: upgradeHeaders });
    } catch (e) {
      wsWarn(this.opts.userId, 'ws construct failed', { attempt, error: String(e) });
      this.scheduleReconnect('construct_failed');
      return;
    }
    this.ws = ws;

    ws.on('pong', () => {
      this.pingMissStreak = 0;
    });

    ws.on('open', () => {
      this.socketOpenedAt = Date.now();
      this.pingMissStreak = 0;
      this.startPing(ws);
      wsLog(this.opts.userId, 'socket open, hello sent', { attempt });
      this.retryIdx = 0;
      const helloPayload: ClientEvent = {
        type: 'hello',
        user_id: this.opts.userId,
        display_name: this.opts.displayName,
        ...(this.opts.agentSecret ? { agent_secret: this.opts.agentSecret } : {}),
      };
      this.sendRaw(helloPayload);
      this.helloAckTimer = setTimeout(() => {
        wsWarn(this.opts.userId, 'hello ack timeout, closing socket', {
          timeoutMs: HELLO_TIMEOUT_MS,
          attempt,
        });
        try { ws.close(); } catch { /* ignore */ }
      }, HELLO_TIMEOUT_MS);
    });

    ws.on('message', (raw) => {
      let parsed: ServerEvent;
      try {
        const obj = JSON.parse(raw.toString('utf-8'));
        const p = ServerEventSchema.safeParse(obj);
        if (!p.success) {
          wsWarn(this.opts.userId, 'invalid server event', { error: p.error.message });
          return;
        }
        parsed = p.data;
      } catch (e) {
        wsWarn(this.opts.userId, 'parse failed', { error: String(e) });
        return;
      }
      if (parsed.type === 'error') {
        wsWarn(this.opts.userId, 'server error event', { code: parsed.code, message: parsed.message });
      }
      if (parsed.type === 'ready') {
        if (this.helloAckTimer) {
          clearTimeout(this.helloAckTimer);
          this.helloAckTimer = null;
        }
        this.isReady = true;
        this.setStatus('open');
        const subs = this.opts.getResubscriptions();
        wsLog(this.opts.userId, 'ready (online)', {
          displayName: parsed.display_name,
          helloMs: this.socketOpenedAt != null ? Date.now() - this.socketOpenedAt : null,
          resubscriptions: subs.length,
        });
        // 重新订阅 + since 补拉
        for (const sub of subs) {
          this.sendRaw({ type: 'subscribe', thread_id: sub.threadId });
          if (sub.cursor) {
            this.sendRaw({ type: 'since', thread_id: sub.threadId, cursor: sub.cursor });
          }
        }
      }
      try {
        this.opts.onEvent(parsed);
      } catch (e) {
        console.error('[webchat-bridge] onEvent threw', e);
      }
    });

    ws.on('error', (err) => {
      wsWarn(this.opts.userId, 'socket error', {
        message: err instanceof Error ? err.message : String(err),
        wasReady: this.isReady,
        status: this.status,
      });
      this.setStatus('error');
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf?.toString('utf-8') || '';
      const sessionMs = this.socketOpenedAt != null ? Date.now() - this.socketOpenedAt : null;
      if (this.helloAckTimer) {
        clearTimeout(this.helloAckTimer);
        this.helloAckTimer = null;
      }
      this.clearPingTimer();
      const wasReady = this.isReady;
      this.isReady = false;
      this.ws = null;
      this.socketOpenedAt = null;
      if (this.closed) {
        wsLog(this.opts.userId, 'socket closed after intentional shutdown', { code, reason, wasReady, sessionMs });
        return;
      }
      wsWarn(this.opts.userId, 'socket closed (will reconnect)', {
        code,
        reason: reason || undefined,
        wasReady,
        sessionMs,
        nextReconnectAttempt: this.retryIdx + 1,
      });
      this.setStatus('closed');
      this.scheduleReconnect('socket_closed');
    });
  }

  private sendRaw(ev: ClientEvent): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== NodeWebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(ev));
    } catch (e) {
      wsWarn(this.opts.userId, 'sendRaw failed', { error: String(e) });
    }
  }

  private startPing(ws: NodeWebSocket): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.closed || ws.readyState !== NodeWebSocket.OPEN) return;
      this.pingMissStreak += 1;
      if (this.pingMissStreak > WS_PING_MISS_LIMIT) {
        wsWarn(this.opts.userId, 'ping timeout, terminating socket', {
          missStreak: this.pingMissStreak,
        });
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        ws.ping();
      } catch (e) {
        wsWarn(this.opts.userId, 'ws ping failed', { error: String(e) });
      }
    }, WS_PING_INTERVAL_MS);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pingMissStreak = 0;
  }

  private scheduleReconnect(cause: string): void {
    if (this.closed) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.retryIdx, RECONNECT_BACKOFF_MS.length - 1)]!;
    const attempt = this.retryIdx + 1;
    wsLog(this.opts.userId, 'reconnect scheduled', { cause, delayMs: delay, attempt });
    this.retryIdx += 1;
    setTimeout(() => {
      if (!this.closed) this.openSocket();
    }, delay);
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    const prev = this.status;
    this.status = s;
    wsLog(this.opts.userId, 'status change', { from: prev, to: s, ready: this.isReady });
    this.opts.onStatusChange?.(s);
  }
}
