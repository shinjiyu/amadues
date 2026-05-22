/**
 * 内存 IM Channel — 记录出站消息，供 integration 断言「用户是否收到完成通知」。
 */
import type { ChatIRChannel, ChatIRInboundEvent, ChatIROutboundBody } from '@utlra/chat-ir';

export interface RecordedOutbound {
  threadId: string;
  body: ChatIROutboundBody;
  at: string;
}

export class FakeImChannel implements ChatIRChannel {
  readonly outbox: RecordedOutbound[] = [];
  private onAgentMessage?: (ev: ChatIRInboundEvent) => Promise<void>;

  /** 模拟 index 装配：channel 入站 → OuterBrain.handleInbound */
  wireInbound(handler: (ev: ChatIRInboundEvent) => Promise<void>): void {
    this.onAgentMessage = handler;
  }

  /** 测试触发入站（不经真实 Discord/WebChat） */
  async emitInbound(ev: ChatIRInboundEvent): Promise<void> {
    if (!this.onAgentMessage) {
      throw new Error('FakeImChannel: call wireInbound() before emitInbound()');
    }
    await this.onAgentMessage(ev);
  }

  start(): void { /* noop */ }
  destroy(): void { /* noop */ }

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    this.outbox.push({ threadId, body, at: new Date().toISOString() });
  }

  lastText(threadId?: string): string | null {
    const list = threadId
      ? this.outbox.filter((m) => m.threadId === threadId)
      : this.outbox;
    const last = list[list.length - 1];
    if (!last) return null;
    return last.body.text ?? null;
  }

  messagesMatching(pattern: RegExp, threadId?: string): RecordedOutbound[] {
    return this.outbox.filter((m) => {
      if (threadId && m.threadId !== threadId) return false;
      const text = m.body.text ?? '';
      return pattern.test(text);
    });
  }
}
