import { describe, expect, it } from 'vitest';

import { AgentHost, type AgentTurn, type PresenceCard } from './host.js';
import { isHostNotificationEcho, toUserSpeech } from './speech.js';

describe('toUserSpeech', () => {
  it('rewrites runtime words before a person sees them', () => {
    const raw = [
      '⏸ 内脑任务等待您的输入',
      '',
      '**任务 ID**：`ib-1`',
      '已派内脑，外脑会盯着这个 KPI burst',
    ].join('\n');
    const spoken = toUserSpeech(raw);
    expect(spoken).toContain('⏸ 需要你补一句');
    expect(spoken).toContain('我去做');
    expect(spoken).not.toMatch(/内脑|外脑|KPI|burst|任务 ID/);
  });

  it('keeps ordinary sentences', () => {
    expect(toUserSpeech('明天把稿子放这儿')).toBe('明天把稿子放这儿');
  });
});

describe('isHostNotificationEcho', () => {
  it('matches legacy and rewritten notices', () => {
    expect(isHostNotificationEcho('⏸ 内脑任务等待您的输入')).toBe(true);
    expect(isHostNotificationEcho('⏸ 需要你补一句')).toBe(true);
    expect(isHostNotificationEcho('❌ 这件没做成')).toBe(true);
    expect(isHostNotificationEcho('普通的一句话')).toBe(false);
  });
});

describe('AgentHost', () => {
  it('registers any adapter and shows peers on handoff', async () => {
    const host = new AgentHost();
    const seen: PresenceCard[][] = [];
    const editor = host.createAgent({
      name: '改稿',
      job: '只改别人交给的稿',
      accept: async (turn: AgentTurn) => {
        seen.push(turn.peers);
        return { say: '改完了' };
      },
    });
    const writer = host.createAgent({
      name: '写稿',
      job: '把材料收成一页',
      accept: async () => ({
        say: '已派内脑',
        presence: { doing: '在收材料' },
        handoff: { toAgentId: editor.id, note: '外脑请你改一版 KPI' },
      }),
    });

    const turns = await host.deliver({
      id: 'm1',
      from: { kind: 'human', id: 'owner' },
      to: { kind: 'agent', id: writer.id },
      text: '写一页',
      at: '2026-10-15T00:00:00.000Z',
    });

    expect(turns[0]?.said).toBe('我去做');
    expect(turns[1]?.toAgentId).toBe(editor.id);
    expect(turns[1]?.said).toBe('改完了');
    expect(seen[0]?.some((card) => card.agentId === writer.id && card.doing === '在收材料')).toBe(
      true,
    );
    expect(seen[0]?.every((card) => card.agentId !== editor.id)).toBe(true);
  });

  it('stores a group message and does not wake agents', async () => {
    const host = new AgentHost();
    let calls = 0;
    const a = host.createAgent({
      name: '甲',
      job: '甲的活',
      accept: async () => {
        calls += 1;
        return {};
      },
    });
    const b = host.createAgent({
      name: '乙',
      job: '乙的活',
      accept: async () => {
        calls += 1;
        return {};
      },
    });
    const group = host.createGroup({ name: '发行', agentIds: [a.id, b.id] });
    const result = await host.deliver({
      id: 'g1',
      from: { kind: 'human', id: 'owner' },
      to: { kind: 'group', id: group.id },
      text: '谁来做',
      at: '2026-10-15T00:00:00.000Z',
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
    expect(host.groupMessages(group.id)).toHaveLength(1);
  });

  it('refuses a group of unknown agents', () => {
    const host = new AgentHost();
    expect(() => host.createGroup({ name: '空', agentIds: ['nope', 'also'] })).toThrow(/unknown agent/);
  });
});
