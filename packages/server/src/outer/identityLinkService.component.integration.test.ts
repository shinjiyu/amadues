/**
 * ADL: identityLinkService
 * path: packages/server/src/outer/identity-link-service.ts
 * horizon.in:  requestLink / confirm / rejectPending / adminForceLink
 * horizon.out: pending → committed 映射；对端未确认则不变
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §3
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityBindingIndex } from '@utlra/chat-ir';
import { createIdentityLinkService } from './identity-link-service.js';

describe('component: identityLinkService', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function harness(opts?: { adminSids?: string[]; now?: () => Date }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ils-'));
    dirs.push(root);
    const index = new IdentityBindingIndex({
      persistPath: path.join(root, 'channel-bindings.json'),
    });
    const delivered: string[] = [];
    const service = createIdentityLinkService({
      index,
      pendingDir: path.join(root, 'link-pending'),
      adminSids: opts?.adminSids,
      ...(opts?.now ? { now: opts.now } : {}),
      deliverConfirm: (p) => {
        delivered.push(p.pending_id);
      },
    });
    return { index, service, delivered, root };
  }

  it('bilateral confirm binds both keys to initiator sid', async () => {
    const { index, service, delivered } = harness();
    const webKey = { channel: 'webchat', native_user_id: 'alice' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_alice', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:alice');

    const req = await service.requestLink({
      initiatorSid: 'idp:user:alice',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
    });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    expect(req.delivered).toBe(true);
    expect(delivered).toContain(req.pending.pending_id);
    expect(index.resolve(feishuKey)).toBeNull();

    const bad = await service.confirm(req.pending.pending_id, webKey);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('actor_not_counterpart');

    const ok = await service.confirm(req.pending.pending_id, feishuKey);
    expect(ok.ok).toBe(true);
    expect(index.resolve(webKey)).toBe('idp:user:alice');
    expect(index.resolve(feishuKey)).toBe('idp:user:alice');
  });

  it('对端是 resolveOrProvision 铸造的孤立 idp sid（仅本 key）→ 同样放行并合并', async () => {
    const { index, service } = harness();
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_b', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');
    const lone = index.resolveOrProvision(feishuKey); // idp:user:<uuid>，只挂这一条 key

    const req = await service.requestLink({
      initiatorSid: 'idp:user:a',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
    });
    expect(req.ok).toBe(true);
    if (!req.ok) return;

    const ok = await service.confirm(req.pending.pending_id, feishuKey);
    expect(ok.ok).toBe(true);
    expect(index.resolve(feishuKey)).toBe('idp:user:a');
    expect(index.listKeys(lone)).toHaveLength(0);
  });

  it('rejectPending leaves mapping unchanged', async () => {
    const { index, service } = harness();
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_x', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');

    const req = await service.requestLink({
      initiatorSid: 'idp:user:a',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
    });
    expect(req.ok).toBe(true);
    if (!req.ok) return;

    expect(service.rejectPending(req.pending.pending_id).ok).toBe(true);
    expect(index.resolve(feishuKey)).toBeNull();
    const conf = await service.confirm(req.pending.pending_id, feishuKey);
    expect(conf.ok).toBe(false);
  });

  it('expired pending cannot confirm', async () => {
    let t = Date.parse('2026-07-16T00:00:00.000Z');
    const { index, service } = harness({
      now: () => new Date(t),
    });
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_x', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');

    const req = await service.requestLink({
      initiatorSid: 'idp:user:a',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
      ttlMs: 1000,
    });
    expect(req.ok).toBe(true);
    if (!req.ok) return;

    t += 5000;
    const conf = await service.confirm(req.pending.pending_id, feishuKey);
    expect(conf.ok).toBe(false);
    if (!conf.ok) expect(conf.reason).toBe('pending_expired');
    expect(index.resolve(feishuKey)).toBeNull();
  });

  it('对端仅自绑（发过言被 provision）→ request 放行，confirm 时 linkMerge 合并', async () => {
    // 回归：任何发过言的账号都会被自动绑到自己的 provisional sid，
    // 旧判定把这种情况当 counterpart_key_already_bound 拒绝 → 正常绑定永远走不通。
    const { index, service } = harness();
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'on_a', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');
    // 对端在飞书发过言：桥自绑 provisional（另有一条无 scope 历史脏键也一并归并）
    index.bind(feishuKey, 'feishu:user:on_a');
    index.bind({ channel: 'feishu', native_user_id: 'on_a' }, 'feishu:user:on_a');

    const req = await service.requestLink({
      initiatorSid: 'idp:user:a',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
    });
    expect(req.ok).toBe(true);
    if (!req.ok) return;

    const ok = await service.confirm(req.pending.pending_id, feishuKey);
    expect(ok.ok).toBe(true);
    // 对端旧 provisional sid 的全部 key（含 scope 变体）都并入 target
    expect(index.resolve(feishuKey)).toBe('idp:user:a');
    expect(index.resolve({ channel: 'feishu', native_user_id: 'on_a' })).toBe('idp:user:a');
    expect(index.listKeys('feishu:user:on_a')).toHaveLength(0);
  });

  it('对端已并入他人身份（sid 含其它账号的 key）→ request 仍拒绝；adminForce 非管理员拒绝', async () => {
    const { index, service } = harness();
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_a', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');
    // 对端 feishu 账号已与另一个 discord 账号合并成真人身份 idp:user:other
    index.bind(feishuKey, 'idp:user:other');
    index.bind({ channel: 'discord', native_user_id: 'd1' }, 'idp:user:other');

    const req = await service.requestLink({
      initiatorSid: 'idp:user:a',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
    });
    expect(req.ok).toBe(false);
    if (!req.ok) expect(req.reason).toBe('counterpart_key_already_bound');

    const forced = service.adminForceLink({
      actorSid: 'idp:user:admin',
      keyA: webKey,
      keyB: feishuKey,
      targetSid: 'idp:user:a',
    });
    expect(forced.ok).toBe(false);
    if (!forced.ok) expect(forced.reason).toBe('not_admin');
  });

  it('adminForceLink merges when actor is admin', () => {
    const { index, service } = harness({ adminSids: ['idp:user:admin'] });
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_a', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');
    const other = index.resolveOrProvision(feishuKey);

    const forced = service.adminForceLink({
      actorSid: 'idp:user:admin',
      keyA: webKey,
      keyB: feishuKey,
      targetSid: 'idp:user:a',
    });
    expect(forced.ok).toBe(true);
    expect(index.resolve(feishuKey)).toBe('idp:user:a');
    expect(index.listKeys(other)).toHaveLength(0);
  });

  it('newcomer cannot steal identity by claiming without counterpart confirm', async () => {
    // 新人从新渠道发起「把 alice 的 webchat 并给我」是合法的 request
    // （同一真人换新号找回旧身份就是这条路）——但防线在 confirm：
    // 必须由对端（alice 的 webchat）本人确认，发起人自己确认无效，映射不变。
    const { index, service } = harness();
    const aKey = { channel: 'webchat', native_user_id: 'alice' };
    const bKey = { channel: 'feishu', native_user_id: 'ou_mallory', scope: 'cli_1' };
    index.bind(aKey, 'idp:user:alice');
    const mallory = index.resolveOrProvision(bKey);

    const req = await service.requestLink({
      initiatorSid: mallory,
      initiatorKey: bKey,
      counterpartKey: aKey,
      targetSid: mallory,
    });
    expect(req.ok).toBe(true);
    if (!req.ok) return;

    // Mallory 自己（用自己的 key）冒充确认 → 拒绝，映射不动
    const fake = await service.confirm(req.pending.pending_id, bKey);
    expect(fake.ok).toBe(false);
    if (!fake.ok) expect(fake.reason).toBe('actor_not_counterpart');
    expect(index.resolve(aKey)).toBe('idp:user:alice');
  });
});
