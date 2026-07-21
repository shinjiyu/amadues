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

  it('rejects request when counterpart key already bound to another sid', async () => {
    const { index, service } = harness();
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_b', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');
    index.bind(feishuKey, 'idp:user:other');

    const req = await service.requestLink({
      initiatorSid: 'idp:user:a',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
    });
    expect(req.ok).toBe(false);
    if (!req.ok) expect(req.reason).toBe('counterpart_key_already_bound');
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

  it('adminForce required when counterpart already provisioned; non-admin denied', async () => {
    const { index, service } = harness();
    const webKey = { channel: 'webchat', native_user_id: 'a' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_a', scope: 'cli_1' };
    index.bind(webKey, 'idp:user:a');
    // 对端曾以新人身份出现——但 request 时若已绑定会拒绝。
    // 模拟：request 时未绑定；confirm 前另一路径误绑？ADL P0：request 时未绑定，
    // confirm 时 bind。另测：counterpart 先 resolveOrProvision 成 src，再 adminForce。
    const src = index.resolveOrProvision(feishuKey);
    expect(src).not.toBe('idp:user:a');

    // 已绑定 → request 应失败
    const req = await service.requestLink({
      initiatorSid: 'idp:user:a',
      initiatorKey: webKey,
      counterpartKey: feishuKey,
    });
    expect(req.ok).toBe(false);

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
    // B（新人）不能通过「我自称是 A」直接改映射——本服务无单方自称 API。
    // 仅能 requestLink 且 initiator 必须是已绑定侧；此处验证映射表未被旁路写入。
    const { index, service } = harness();
    const aKey = { channel: 'webchat', native_user_id: 'alice' };
    const bKey = { channel: 'feishu', native_user_id: 'ou_mallory', scope: 'cli_1' };
    index.bind(aKey, 'idp:user:alice');
    const mallory = index.resolveOrProvision(bKey);

    // Mallory 若发起「把 alice 的 webchat 绑到我」——initiator_key 与 initiatorSid 不一致会被拒
    const steal = await service.requestLink({
      initiatorSid: mallory,
      initiatorKey: bKey,
      counterpartKey: aKey,
      targetSid: mallory,
    });
    expect(steal.ok).toBe(false);
    if (!steal.ok) expect(steal.reason).toBe('counterpart_key_already_bound');
    expect(index.resolve(aKey)).toBe('idp:user:alice');
  });
});
