/**
 * 浏览器端 WS 客户端 —— 断线重连 + since 补拉 + 事件订阅。
 *
 * 调用顺序：
 * 1. new WebChatWs({ identity, onEvent })
 * 2. ws.connect()  → 自动发 hello + presence.sync
 * 3. ws.subscribe(threadId)  /  ws.since(threadId, cursor)
 * 4. ws.close()  完全断开（停止重连）
 *
 * 重连：指数退避 1s → 2s → 4s → 8s（封顶 8s）；保留所有已订阅 threadId，重连后自动 re-subscribe + since。
 */
import type { ClientEvent, ServerEvent } from '@utlra/webchat-protocol';
import type { ClientIdentity } from './auth.js';

type Listener = (ev: ServerEvent) => void;

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface WebChatWsOptions {
  identity: ClientIdentity;
  onEvent: Listener;
  onStatusChange?: (s: ConnectionStatus) => void;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];
const HELLO_TIMEOUT_MS = 15_000;
/**
 * 浏览器 WebSocket API 无法发协议层 ping 帧；用空串作应用层保活（与 agent 侧 ws.ping 等效目的）。
 * 间隔与 agent bridge 一致：30s。
 */
const WS_KEEPALIVE_INTERVAL_MS = 30_000;

function deriveWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return `${proto}//${location.host}${base}/ws`;
}

export class WebChatWs {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, string | null>();
  private closed = false;
  private retryIdx = 0;
  private status: ConnectionStatus = 'idle';
  private helloAckTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private isReady = false;

  constructor(private readonly opts: WebChatWsOptions) {}

  connect(): void {
    if (this.ws && (this.status === 'open' || this.status === 'connecting')) return;
    this.closed = false;
    this.openSocket();
  }

  /**
   * 订阅 thread。重连后会自动重新订阅；如果同时传 `lastSeen`，会在 hello/ready 后补拉。
   */
  subscribe(threadId: string, lastSeen: string | null = null): void {
    this.subscriptions.set(threadId, lastSeen);
    if (this.isReady) {
      this.sendRaw({ type: 'subscribe', thread_id: threadId });
      // cursor 为 null 时不发 since，避免重放整段历史（切回大群时会导致列表滚动错位）
      if (lastSeen) {
        this.sendRaw({ type: 'since', thread_id: threadId, cursor: lastSeen });
      }
    }
  }

  /** 上报输入活动（瞬时信号）。服务端扇出 typing.relay 给线程其它订阅者。 */
  sendTyping(threadId: string, state: 'start' | 'stop'): void {
    if (!this.isReady) return;
    this.sendRaw({ type: 'typing', thread_id: threadId, state });
  }

  /** 更新已记得的 cursor（每收到新消息时调用一次，重连时用于补拉） */
  updateCursor(threadId: string, lastSeen: string): void {
    if (this.subscriptions.has(threadId)) {
      this.subscriptions.set(threadId, lastSeen);
    }
  }

  close(): void {
    this.closed = true;
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer);
      this.helloAckTimer = null;
    }
    this.clearKeepaliveTimer();
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  private openSocket(): void {
    this.setStatus('connecting');
    this.isReady = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(deriveWsUrl());
    } catch (e) {
      console.warn('[webchat-ws] construct failed', e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryIdx = 0;
      this.startKeepalive(ws);
      this.sendRaw({
        type: 'hello',
        user_id: this.opts.identity.user_id,
        display_name: this.opts.identity.display_name,
      });
      this.helloAckTimer = setTimeout(() => {
        console.warn('[webchat-ws] hello ack timeout, closing');
        try { ws.close(); } catch { /* ignore */ }
      }, HELLO_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(event.data) as ServerEvent;
      } catch (e) {
        console.warn('[webchat-ws] parse failed', e);
        return;
      }
      if (parsed.type === 'ready') {
        if (this.helloAckTimer) {
          clearTimeout(this.helloAckTimer);
          this.helloAckTimer = null;
        }
        this.isReady = true;
        this.setStatus('open');
        // re-subscribe + since
        for (const [threadId, cursor] of this.subscriptions) {
          this.sendRaw({ type: 'subscribe', thread_id: threadId });
          if (cursor) {
            this.sendRaw({ type: 'since', thread_id: threadId, cursor });
          }
        }
      }
      this.opts.onEvent(parsed);
    };

    ws.onerror = () => {
      this.setStatus('error');
    };

    ws.onclose = () => {
      if (this.helloAckTimer) {
        clearTimeout(this.helloAckTimer);
        this.helloAckTimer = null;
      }
      this.clearKeepaliveTimer();
      this.isReady = false;
      this.ws = null;
      if (!this.closed) {
        this.setStatus('closed');
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.retryIdx, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.retryIdx += 1;
    setTimeout(() => {
      if (!this.closed) this.openSocket();
    }, delay);
  }

  private sendRaw(ev: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(ev));
    } catch (e) {
      console.warn('[webchat-ws] send failed', e);
    }
  }

  private startKeepalive(ws: WebSocket): void {
    this.clearKeepaliveTimer();
    this.keepaliveTimer = setInterval(() => {
      if (this.closed || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send('');
      } catch (e) {
        console.warn('[webchat-ws] keepalive send failed', e);
      }
    }, WS_KEEPALIVE_INTERVAL_MS);
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatusChange?.(s);
  }
}
