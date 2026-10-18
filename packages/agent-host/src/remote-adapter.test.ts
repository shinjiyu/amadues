import { describe, expect, it } from 'vitest';

import { AgentHost, type AgentTurn } from './host.js';
import { createRemoteAccept } from './remote-adapter.js';

describe('createRemoteAccept', () => {
  it('posts the turn and returns say, presence, and handoff', async () => {
    let posted: unknown;
    const accept = createRemoteAccept({
      url: 'http://teammate.example/agent-adapter/accept',
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            say: '写好了',
            presence: { doing: '在写' },
            handoff: { toAgentId: 'editor', note: '请看一眼' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const turn: AgentTurn = {
      message: {
        id: 'm1',
        from: { kind: 'human', id: 'owner' },
        to: { kind: 'agent', id: 'writer' },
        text: '写一页',
        at: '2026-10-17T00:00:00.000Z',
      },
      roster: [{ id: 'editor', name: '改稿', job: '改别人的稿' }],
      peers: [],
    };
    const result = await accept(turn);
    expect(posted).toEqual({
      message: turn.message,
      roster: turn.roster,
      peers: [],
    });
    expect(result.say).toBe('写好了');
    expect(result.handoff?.note).toBe('请看一眼');
  });

  it('can be the accept a host calls', async () => {
    const host = new AgentHost();
    const editor = host.createAgent({
      name: '改稿',
      job: '改别人的稿',
      accept: async () => ({ say: '改完了' }),
    });
    host.createAgent({
      name: '写稿',
      job: '写一页',
      accept: createRemoteAccept({
        url: 'http://teammate.example/agent-adapter/accept',
        fetch: async () =>
          new Response(
            JSON.stringify({
              say: '已派内脑',
              handoff: { toAgentId: editor.id, note: '外脑请你改一版 KPI' },
            }),
            { status: 200 },
          ),
      }),
    });
    const writer = host.listAgents().find((agent) => agent.name === '写稿');
    const turns = await host.deliver({
      id: 'm2',
      from: { kind: 'human', id: 'owner' },
      to: { kind: 'agent', id: writer!.id },
      text: '写一页',
      at: '2026-10-17T00:00:00.000Z',
    });
    expect(turns[0]?.said).toBe('已派内脑');
    expect(turns[1]?.said).toBe('改完了');
  });
});
