/**
 * ADL: chatIrLib · FanInChatIRChannel
 * path: packages/chat-ir/src/runtime/fan-in-channel.ts
 * horizon.in:  N 条 ChatIRChannel 连接的入站事件；agent postMessage/sendActivity
 * horizon.out: 合流后的单一 onAgentMessage；出站按 thread→connection 路由
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5.2 装配
 */
import { describe, expect, it } from 'vitest';
import type { ChatIRChannel, ChatIRInboundEvent, ChatIROutboundBody } from '../channel.js';
import { FanInChatIRChannel } from './fan-in-channel.js';

class FakeChannel implements ChatIRChannel {
  started = 0;
  destroyed = 0;
  posts: Array<{ threadId: string; body: ChatIROutboundBody }> = [];
  activities: Array<{ threadId: string; kind: string }> = [];
  start(): void {
    this.started++;
  }
  destroy(): void {
    this.destroyed++;
  }
  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    this.posts.push({ threadId, body });
  }
  sendActivity(threadId: string, kind: 'typing' | 'idle'): void {
    this.activities.push({ threadId, kind });
  }
}

function inboundEv(threadId: string, senderSid = 'idp:user:alice'): ChatIRInboundEvent {
  return {
    threadId,
    senderSid,
    message: {
      message_id: `m-${Math.random().toString(36).slice(2)}`,
      thread_id: threadId,
      sender_sid: senderSid,
      sent_at: new Date().toISOString(),
      parts: [{ type: 'text', text: 'hi' }],
    },
    participantSids: [senderSid],
  };
}

function harness() {
  const received: ChatIRInboundEvent[] = [];
  const fanIn = new FanInChatIRChannel({
    onAgentMessage: async (ev) => {
      received.push(ev);
    },
  });
  return { fanIn, received };
}

describe('FanInChatIRChannel', () => {
  it('forwards inbound from any connection and records thread route', async () => {
    const { fanIn, received } = harness();
    const a = new FakeChannel();
    const b = new FakeChannel();
    fanIn.addConnection('conn-a', a, { isDefault: true });
    fanIn.addConnection('conn-b', b);

    await fanIn.makeInboundHandler('conn-b')(inboundEv('feishu:chat:1'));
    expect(received).toHaveLength(1);
    expect(fanIn.routeForThread('feishu:chat:1')).toBe('conn-b');
  });

  it('routes outbound to owning connection; unknown thread → default', async () => {
    const { fanIn } = harness();
    const a = new FakeChannel();
    const b = new FakeChannel();
    fanIn.addConnection('conn-a', a, { isDefault: true });
    fanIn.addConnection('conn-b', b);
    await fanIn.makeInboundHandler('conn-b')(inboundEv('feishu:chat:1'));

    await fanIn.postMessage('feishu:chat:1', { sender_sid: 'idp:agent:x', text: 'reply' });
    expect(b.posts).toHaveLength(1);
    expect(a.posts).toHaveLength(0);

    await fanIn.postMessage('webchat:thread:9', { sender_sid: 'idp:agent:x', text: 'hello' });
    expect(a.posts).toHaveLength(1);
  });

  it('sendActivity routes like postMessage and is best-effort', async () => {
    const { fanIn } = harness();
    const a = new FakeChannel();
    fanIn.addConnection('conn-a', a, { isDefault: true });
    await fanIn.makeInboundHandler('conn-a')(inboundEv('t1'));

    fanIn.sendActivity('t1', 'typing');
    expect(a.activities).toEqual([{ threadId: 't1', kind: 'typing' }]);

    // 无任何连接时不抛
    const empty = new FanInChatIRChannel({ onAgentMessage: async () => {} });
    expect(() => empty.sendActivity('t1', 'typing')).not.toThrow();
    await expect(
      empty.postMessage('t1', { sender_sid: 'idp:agent:x', text: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('start/destroy propagate; hot-added connection starts if fan-in already started', () => {
    const { fanIn } = harness();
    const a = new FakeChannel();
    fanIn.addConnection('conn-a', a, { isDefault: true });
    fanIn.start();
    expect(a.started).toBe(1);

    const late = new FakeChannel();
    fanIn.addConnection('conn-late', late);
    expect(late.started).toBe(1);

    fanIn.destroy();
    expect(a.destroyed).toBe(1);
    expect(late.destroyed).toBe(1);
  });

  it('removeConnection destroys channel, clears routes, refuses duplicate add', async () => {
    const { fanIn } = harness();
    const a = new FakeChannel();
    const b = new FakeChannel();
    fanIn.addConnection('conn-a', a, { isDefault: true });
    fanIn.addConnection('conn-b', b);
    expect(() => fanIn.addConnection('conn-b', new FakeChannel())).toThrow(/exists/i);

    await fanIn.makeInboundHandler('conn-b')(inboundEv('feishu:chat:1'));
    expect(fanIn.removeConnection('conn-b')).toBe(true);
    expect(b.destroyed).toBe(1);
    expect(fanIn.routeForThread('feishu:chat:1')).toBeNull();

    // 移除后出站落到 default
    await fanIn.postMessage('feishu:chat:1', { sender_sid: 'idp:agent:x', text: 'r' });
    expect(a.posts).toHaveLength(1);

    expect(fanIn.removeConnection('conn-b')).toBe(false);
    expect(fanIn.listConnections()).toEqual(['conn-a']);
  });
});
