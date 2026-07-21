/**
 * ADL: chatIrLib · FanInChatIRChannel
 * path: packages/chat-ir/src/runtime/fan-in-channel.ts
 * horizon.intention: 进程入口不再假设唯一 ChatIRChannel——N 条连接入站合流、出站按 thread→connection 路由
 * horizon.in:  addConnection/removeConnection（热插）；各连接入站事件；agent postMessage/sendActivity
 * horizon.out: 单一 onAgentMessage 回调；出站转发到 owning connection（未知 thread → default）
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5.2
 *
 * 路由规则刻意保持最小：入站时记 thread→connection；出站查表，查不到走 default 连接。
 * thread_id 全局唯一由各桥的 thread-mapper 保证（带渠道前缀），fan-in 不解析其结构。
 */
import type {
  ChatIRChannel,
  ChatIRInboundEvent,
  ChatIROutboundBody,
} from '../channel.js';

export interface FanInChannelOptions {
  onAgentMessage: (ev: ChatIRInboundEvent) => Promise<void>;
}

interface ConnectionEntry {
  channel: ChatIRChannel;
  isDefault: boolean;
}

export class FanInChatIRChannel implements ChatIRChannel {
  private readonly connections = new Map<string, ConnectionEntry>();
  private readonly threadRoutes = new Map<string, string>();
  private readonly onAgentMessage: FanInChannelOptions['onAgentMessage'];
  private started = false;

  constructor(opts: FanInChannelOptions) {
    this.onAgentMessage = opts.onAgentMessage;
  }

  /**
   * 注册一条连接。fan-in 已 start 时新连接立即 start（热插）。
   * 连接自身的 onAgentMessage 应指向 `makeInboundHandler(connectionId)` 的返回值。
   */
  addConnection(
    connectionId: string,
    channel: ChatIRChannel,
    opts: { isDefault?: boolean } = {},
  ): void {
    if (this.connections.has(connectionId)) {
      throw new Error(`connection already exists: ${connectionId}`);
    }
    this.connections.set(connectionId, {
      channel,
      isDefault: opts.isDefault ?? false,
    });
    if (this.started) channel.start();
  }

  /** 摘除连接：destroy channel 并清掉它的 thread 路由。 */
  removeConnection(connectionId: string): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry) return false;
    this.connections.delete(connectionId);
    try {
      entry.channel.destroy();
    } catch (e) {
      console.error(`[chat-ir][fan-in] destroy failed for ${connectionId}`, e);
    }
    for (const [threadId, connId] of this.threadRoutes) {
      if (connId === connectionId) this.threadRoutes.delete(threadId);
    }
    return true;
  }

  listConnections(): string[] {
    return [...this.connections.keys()];
  }

  /** 某 thread 当前路由到的 connection id；未见过 → null */
  routeForThread(threadId: string): string | null {
    return this.threadRoutes.get(threadId) ?? null;
  }

  /**
   * 为某条连接生成入站回调：记录 thread→connection 后转发给 agent。
   * 桥构造时把它作为自己的 `onAgentMessage` 注入。
   */
  makeInboundHandler(connectionId: string): (ev: ChatIRInboundEvent) => Promise<void> {
    return async (ev) => {
      this.threadRoutes.set(ev.threadId, connectionId);
      await this.onAgentMessage(ev);
    };
  }

  start(): void {
    this.started = true;
    for (const { channel } of this.connections.values()) channel.start();
  }

  destroy(): void {
    this.started = false;
    for (const [id] of [...this.connections]) this.removeConnection(id);
  }

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    const target = this.resolveTarget(threadId);
    if (!target) {
      console.warn(`[chat-ir][fan-in] no connection for outbound thread=${threadId}; dropped`);
      return;
    }
    await target.postMessage(threadId, body);
  }

  sendActivity(threadId: string, kind: 'typing' | 'idle'): void {
    const target = this.resolveTarget(threadId);
    try {
      target?.sendActivity?.(threadId, kind);
    } catch (e) {
      console.warn(`[chat-ir][fan-in] sendActivity failed thread=${threadId}`, e);
    }
  }

  private resolveTarget(threadId: string): ChatIRChannel | null {
    const routed = this.threadRoutes.get(threadId);
    if (routed) {
      const entry = this.connections.get(routed);
      if (entry) return entry.channel;
    }
    for (const entry of this.connections.values()) {
      if (entry.isDefault) return entry.channel;
    }
    // 无显式 default：单连接时退化为该连接
    if (this.connections.size === 1) {
      return [...this.connections.values()][0].channel;
    }
    return null;
  }
}
