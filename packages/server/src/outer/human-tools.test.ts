import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IdentityRegistry } from '@utlra/chat-ir';
import {
  buildHumanToolRegistry,
  renderHumanToolRoster,
  resolveHumanTarget,
  renderHumanToolMessage,
  channelFromSid,
  makeHumanRequestRecord,
  recordHumanRequest,
  loadHumanLedger,
  checkHumanCallAllowed,
  resolvePendingForSender,
  deriveRequestStates,
  computeReliability,
  NOTIFY_COOLDOWN_MS,
  type HumanToolProfile,
} from './human-tools.js';
import { createTestDataRoot } from '../testing/temp-data-root.js';

function reg(root: ReturnType<typeof createTestDataRoot>): IdentityRegistry {
  const r = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
  r.upsert({
    schema: 'identity.v1',
    sid: 'wechat:user:feng',
    kind: 'human',
    display_name: '冯亮',
    aliases: [],
    roles_in_tenant: [],
    bindings: [],
    updated_at: new Date().toISOString(),
  });
  return r;
}

describe('human-tools registry', () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('includes thread humans, excludes agents and self, applies overrides', () => {
    const root = createTestDataRoot('human-tools-');
    cleanup = root.cleanup;
    const profiles = buildHumanToolRegistry({
      registry: reg(root),
      agentSid: 'idp:agent:aki',
      candidateSids: ['wechat:user:feng', 'idp:agent:aki', 'idp:agent:kuroneko'],
      overrides: {
        'wechat:user:feng': { capabilities: ['payment', 'physical_action'], reliability: 0.95, cost: 'paid' },
      },
    });
    expect(profiles).toHaveLength(1);
    const p = profiles[0]!;
    expect(p.sid).toBe('wechat:user:feng');
    expect(p.displayName).toBe('冯亮');
    expect(p.channel).toBe('wechat');
    expect(p.capabilities).toContain('payment');
    expect(p.reliability).toBeCloseTo(0.95);
    expect(p.cost).toBe('paid');
  });

  it('channelFromSid parses the prefix', () => {
    expect(channelFromSid('wechat:user:x')).toBe('wechat');
    expect(channelFromSid('idp:feishu:user:x')).toBe('feishu');
    expect(channelFromSid('garbage')).toBe('unknown');
  });

  it('roster is explicit when empty and lists capabilities otherwise', () => {
    expect(renderHumanToolRoster([])).toContain('没有登记在册的人类');
    const roster = renderHumanToolRoster([
      { sid: 's', displayName: '冯亮', capabilities: ['approval'], channel: 'wechat', reliability: 0.9, cost: 'favor' },
    ]);
    expect(roster).toContain('冯亮');
    expect(roster).toContain('approval');
    expect(roster).toContain('90%');
  });

  it('resolves target by sid or display name, else null', () => {
    const profiles: HumanToolProfile[] = [
      { sid: 'wechat:user:feng', displayName: '冯亮', capabilities: [], channel: 'wechat', reliability: 0.7, cost: 'favor' },
    ];
    expect(resolveHumanTarget(profiles, 'wechat:user:feng')?.displayName).toBe('冯亮');
    expect(resolveHumanTarget(profiles, '冯亮')?.sid).toBe('wechat:user:feng');
    expect(resolveHumanTarget(profiles, '陌生人')).toBeNull();
  });

  it('renders an addressed, categorized message and a pending record', () => {
    const target: HumanToolProfile = {
      sid: 'wechat:user:feng', displayName: '冯亮', capabilities: [], channel: 'wechat', reliability: 0.7, cost: 'favor',
    };
    expect(renderHumanToolMessage('human_request', target, '帮我把板子上电')).toBe(
      '@冯亮 【请求协助】帮我把板子上电',
    );
    const rec = makeHumanRequestRecord({
      kind: 'human_query',
      target,
      content: '板子型号是什么',
      threadId: 't1',
      now: 1_700_000_000_000,
    });
    expect(rec).toMatchObject({
      kind: 'human_query',
      targetSid: 'wechat:user:feng',
      targetName: '冯亮',
      threadId: 't1',
      status: 'pending',
    });
    expect(rec.id).toMatch(/^hreq-/);
    expect(rec.timeoutMs).toBeGreaterThan(0);
  });
});

describe('human-tools ledger', () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  const feng: HumanToolProfile = {
    sid: 'wechat:user:feng', displayName: '冯亮', capabilities: [], channel: 'wechat', reliability: 0.7, cost: 'favor',
  };
  const T0 = Date.parse('2026-10-09T10:00:00Z');

  it('blocks a second request while one is pending; reopens after answer', () => {
    const root = createTestDataRoot('human-ledger-');
    cleanup = root.cleanup;
    recordHumanRequest(
      root.dataRoot,
      makeHumanRequestRecord({ kind: 'human_request', target: feng, content: '上电', threadId: 't1', now: T0 }),
    );
    const ledger1 = loadHumanLedger(root.dataRoot);
    expect(checkHumanCallAllowed(ledger1, 'human_query', feng.sid, T0 + 1000)).toMatch(/未结请求/);
    // 另一个人不受影响
    expect(checkHumanCallAllowed(ledger1, 'human_query', 'wechat:user:other', T0 + 1000)).toBeNull();

    const resolved = resolvePendingForSender({
      dataRoot: root.dataRoot,
      senderSid: feng.sid,
      threadId: 't1',
      replyText: '好了，已上电',
      now: T0 + 60_000,
    });
    expect(resolved?.content).toBe('上电');
    const ledger2 = loadHumanLedger(root.dataRoot);
    expect(deriveRequestStates(ledger2, T0 + 61_000)[0]?.state).toBe('answered');
    expect(checkHumanCallAllowed(ledger2, 'human_query', feng.sid, T0 + 61_000)).toBeNull();
  });

  it('does not correlate replies from other threads or other people', () => {
    const root = createTestDataRoot('human-ledger-');
    cleanup = root.cleanup;
    recordHumanRequest(
      root.dataRoot,
      makeHumanRequestRecord({ kind: 'human_query', target: feng, content: '型号？', threadId: 't1', now: T0 }),
    );
    expect(
      resolvePendingForSender({ dataRoot: root.dataRoot, senderSid: feng.sid, threadId: 't2', replyText: 'x', now: T0 + 1 }),
    ).toBeNull();
    expect(
      resolvePendingForSender({ dataRoot: root.dataRoot, senderSid: 'wechat:user:other', threadId: 't1', replyText: 'x', now: T0 + 1 }),
    ).toBeNull();
  });

  it('expired requests become timed_out, unblock, and lower reliability', () => {
    const root = createTestDataRoot('human-ledger-');
    cleanup = root.cleanup;
    recordHumanRequest(
      root.dataRoot,
      makeHumanRequestRecord({ kind: 'human_request', target: feng, content: 'a', threadId: 't1', now: T0, timeoutMs: 1000 }),
    );
    const ledger = loadHumanLedger(root.dataRoot);
    const later = T0 + 5000;
    expect(deriveRequestStates(ledger, later)[0]?.state).toBe('timed_out');
    expect(checkHumanCallAllowed(ledger, 'human_request', feng.sid, later)).toBeNull();
    // 先验 0.7×2，1 次超时 → 1.4/3
    expect(computeReliability(ledger, feng.sid, later)).toBeCloseTo(1.4 / 3);
    // 无历史 → 先验
    expect(computeReliability([], feng.sid, later)).toBeCloseTo(0.7);
  });

  it('notify has a cooldown per person', () => {
    const root = createTestDataRoot('human-ledger-');
    cleanup = root.cleanup;
    recordHumanRequest(
      root.dataRoot,
      makeHumanRequestRecord({ kind: 'human_notify', target: feng, content: 'fyi', threadId: 't1', now: T0 }),
    );
    const ledger = loadHumanLedger(root.dataRoot);
    expect(checkHumanCallAllowed(ledger, 'human_notify', feng.sid, T0 + 60_000)).toMatch(/30 分钟/);
    expect(checkHumanCallAllowed(ledger, 'human_notify', feng.sid, T0 + NOTIFY_COOLDOWN_MS + 1)).toBeNull();
    // notify 不占用 query/request 通道
    expect(checkHumanCallAllowed(ledger, 'human_query', feng.sid, T0 + 60_000)).toBeNull();
  });
});
