import { describe, expect, it } from 'vitest';

import {
  acceptAmadeusTurn,
  hostThreadId,
  presenceForHostThread,
  recordHostHandoff,
  renderHostTurnText,
} from './amadeus-agent-adapter.js';
import type { OuterHttpInboundParams } from './outer-http-inbound.js';

const turn = {
  message: {
    id: 'm1',
    from: { kind: 'human' as const, id: 'owner' },
    to: { kind: 'agent' as const, id: 'amadeus' },
    text: '写一页',
    at: '2026-10-17T00:00:00.000Z',
  },
  roster: [{ id: 'editor', name: '改稿', job: '改别人的稿' }],
  peers: [{ agentId: 'editor', doing: '在看上一版', waitingOn: null, updatedAt: '2026-10-17T00:00:00.000Z' }],
};

describe('acceptAmadeusTurn', () => {
  it('names the host thread after the message and does not use an IM thread', () => {
    expect(hostThreadId('m1')).toBe('thread:dm:host:m1');
  });

  it('puts roster names into the turn text', () => {
    const text = renderHostTurnText(turn);
    expect(text).toContain('改稿');
    expect(text).toContain('id=editor');
    expect(text).toContain('写一页');
  });

  it('returns say and handoff from the captured turn, and presence from the bench', async () => {
    let params: OuterHttpInboundParams | undefined;
    const result = await acceptAmadeusTurn(turn, {
      dispatch: async (input) => {
        params = input;
        input.hostHandoffSink!.handoff = { toAgentId: 'editor', note: '请看一眼' };
        return {
          threadId: input.threadId,
          messageId: 'msg:1',
          replies: [{ threadId: input.threadId, senderSid: 'idp:agent:kuroneko', text: '我来写', sentAt: 't' }],
        };
      },
      tasks: () => [
        {
          originThread: hostThreadId('m1'),
          status: 'AWAITING',
          goal: '把材料收成一页',
          startedAt: '2026-10-17T00:00:00.000Z',
        },
      ],
    });
    expect(params?.threadId).toBe('thread:dm:host:m1');
    expect(params?.hostRosterIds).toEqual(['editor']);
    expect(result.say).toBe('我来写');
    expect(result.handoff).toEqual({ toAgentId: 'editor', note: '请看一眼' });
    expect(result.presence).toEqual({ doing: '把材料收成一页', waitingOn: 'owner' });
  });

  it('leaves say empty when the conversation posted nothing', async () => {
    const result = await acceptAmadeusTurn(turn, {
      dispatch: async (input) => ({
        threadId: input.threadId,
        messageId: 'msg:2',
        replies: [],
      }),
      tasks: () => [],
    });
    expect(result.say).toBeUndefined();
    expect(result.presence).toBeUndefined();
    expect(result.handoff).toBeUndefined();
  });

  it('rejects a body without a message', async () => {
    await expect(
      acceptAmadeusTurn({}, { dispatch: async () => { throw new Error('no'); }, tasks: () => [] }),
    ).rejects.toThrow(/bad accept/);
  });
});

describe('recordHostHandoff', () => {
  it('keeps a note for a roster id and refuses anyone else', () => {
    const sink: { handoff?: { toAgentId: string; note: string } } = {};
    expect(recordHostHandoff(['editor'], { toAgentId: 'editor', note: '请看一眼' }, sink)).toContain(
      '已记下',
    );
    expect(sink.handoff).toEqual({ toAgentId: 'editor', note: '请看一眼' });
    expect(recordHostHandoff(['editor'], { toAgentId: 'stranger', note: '不行' }, sink)).toContain(
      '不在',
    );
    expect(sink.handoff?.toAgentId).toBe('editor');
  });
});

describe('presenceForHostThread', () => {
  it('ignores a bench that belongs to another thread', () => {
    expect(
      presenceForHostThread(
        [
          {
            originThread: 'thread:wechat:1',
            status: 'RUNNING',
            goal: '别的事',
            startedAt: '2026-10-17T00:00:00.000Z',
          },
        ],
        'thread:dm:host:m1',
        'owner',
      ),
    ).toBeUndefined();
  });
});
