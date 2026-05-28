/**
 * Node 端 WS 客户端 —— 自动重连 + hello + subscribe。
 *
 * 与浏览器版 `apps/web-chat/src/ws.ts` 形态一致，但用 npm `ws` 包。
 */
import { WebSocket as NodeWebSocket } from 'ws';
import { ClientEventSchema, ServerEventSchema, type ClientEvent, type ServerEvent } from '@utlra/webchat-protocol';

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const HELLO_TIMEOUT_MS = 15_000;

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
  private isReady = false;

  constructor(private readonly opts: WebChatWsOptions) {}

  connect(): void {
    if (this.ws && (this.status === 'open' || this.status === 'connecting')) return;
    this.closed = false;
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer);
      this.helloAckTimer = null;
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.setStatus('closed');
  }

  send(ev: ClientEvent): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== NodeWebSocket.OPEN) return;
    const parsed = ClientEventSchema.safeParse(ev);
    if (!parsed.success) {
      console.warn('[webchat-bridge] outbound event invalid', parsed.error.message);
      return;
    }
    try {
      ws.send(JSON.stringify(ev));
    } catch (e) {
      console.warn('[webchat-bridge] ws send failed', e);
    }
  }

  isOpen(): boolean {
    return this.status === 'open' && this.isReady;
  }

  private openSocket(): void {
    this.setStatus('connecting');
    this.isReady = false;
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
      console.warn('[webchat-bridge] ws construct failed', e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.retryIdx = 0;
      const helloPayload: ClientEvent = {
        type: 'hello',
        user_id: this.opts.userId,
        display_name: this.opts.displayName,
        ...(this.opts.agentSecret ? { agent_secret: this.opts.agentSecret } : {}),
      };
      this.sendRaw(helloPayload);
      this.helloAckTimer = setTimeout(() => {
        console.warn('[webchat-bridge] hello ack timeout, closing');
        try { ws.close(); } catch { /* ignore */ }
      }, HELLO_TIMEOUT_MS);
    });

    ws.on('message', (raw) => {
      let parsed: ServerEvent;
      try {
        const obj = JSON.parse(raw.toString('utf-8'));
        const p = ServerEventSchema.safeParse(obj);
        if (!p.success) {
          console.warn('[webchat-bridge] invalid server event', p.error.message);
          return;
        }
        parsed = p.data;
      } catch (e) {
        console.warn('[webchat-bridge] parse failed', e);
        return;
      }
      if (parsed.type === 'ready') {
        if (this.helloAckTimer) {
          clearTimeout(this.helloAckTimer);
          this.helloAckTimer = null;
        }
        this.isReady = true;
        this.setStatus('open');
        // 重新订阅 + since 补拉
        for (const sub of this.opts.getResubscriptions()) {
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
      console.warn('[webchat-bridge] ws error', err);
      this.setStatus('error');
    });

    ws.on('close', () => {
      if (this.helloAckTimer) {
        clearTimeout(this.helloAckTimer);
        this.helloAckTimer = null;
      }
      this.isReady = false;
      this.ws = null;
      if (!this.closed) {
        this.setStatus('closed');
        this.scheduleReconnect();
      }
    });
  }

  private sendRaw(ev: ClientEvent): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== NodeWebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(ev));
    } catch (e) {
      console.warn('[webchat-bridge] sendRaw failed', e);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.retryIdx, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.retryIdx += 1;
    setTimeout(() => {
      if (!this.closed) this.openSocket();
    }, delay);
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatusChange?.(s);
  }
}
