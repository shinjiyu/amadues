/**
 * ADL: identityLinkService · 入站确认/拒绝解析
 * path: packages/server/src/outer/identity-link-inbound.ts
 * horizon.in:  human IM text + senderSid
 * horizon.out: handled/committed + 回复文案
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §3.2
 */
import { describe, expect, it } from 'vitest';
import { IdentityBindingIndex } from '@utlra/chat-ir';
import { createIdentityLinkService } from './identity-link-service.js';
import { tryHandleIdentityLinkInbound } from './identity-link-inbound.js';

function harness() {
  const index = new IdentityBindingIndex({ persistPath: null });
  const service = createIdentityLinkService({ index, pendingDir: null });
  return { index, service };
}

const WEB_KEY = { channel: 'webchat', native_user_id: 'alice' };
const FEISHU_KEY = { channel: 'feishu', native_user_id: 'ou_alice', scope: 'cli_1' };

async function makePending(h: ReturnType<typeof harness>) {
  h.index.bind(WEB_KEY, 'idp:user:alice');
  const req = await h.service.requestLink({
    initiatorSid: 'idp:user:alice',
    initiatorKey: WEB_KEY,
    counterpartKey: FEISHU_KEY,
  });
  if (!req.ok) throw new Error(`requestLink failed: ${req.reason}`);
  return req.pending;
}

describe('identity-link-inbound', () => {
  it('plain chat text is not handled', async () => {
    const h = harness();
    const res = await tryHandleIdentityLinkInbound(
      { service: h.service, index: h.index },
      'idp:user:alice',
      '今天天气不错，帮我查个东西',
    );
    expect(res.handled).toBe(false);
  });

  it('confirm from counterpart account commits and merges provisional sid', async () => {
    const h = harness();
    const pending = await makePending(h);

    // 对端首次入站：桥把 feishu key 绑到 provisional sid
    h.index.bind(FEISHU_KEY, 'feishu:user:ou_alice');

    const res = await tryHandleIdentityLinkInbound(
      { service: h.service, index: h.index },
      'feishu:user:ou_alice',
      `确认绑定 ${pending.pending_id}`,
    );
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.committed).toBe(true);

    // 两条 key 均指向 initiator sid；provisional 已合并
    expect(h.index.resolve(WEB_KEY)).toBe('idp:user:alice');
    expect(h.index.resolve(FEISHU_KEY)).toBe('idp:user:alice');
    expect(h.index.listKeys('feishu:user:ou_alice')).toHaveLength(0);
  });

  it('english "confirm link <id>" also works', async () => {
    const h = harness();
    const pending = await makePending(h);
    h.index.bind(FEISHU_KEY, 'feishu:user:ou_alice');

    const res = await tryHandleIdentityLinkInbound(
      { service: h.service, index: h.index },
      'feishu:user:ou_alice',
      `confirm link ${pending.pending_id}`,
    );
    expect(res.handled && res.committed).toBe(true);
  });

  it('confirm from wrong account is refused; mapping unchanged', async () => {
    const h = harness();
    const pending = await makePending(h);
    // Mallory 在 feishu 的另一账号
    h.index.bind({ channel: 'feishu', native_user_id: 'ou_mallory', scope: 'cli_1' }, 'feishu:user:ou_mallory');

    const res = await tryHandleIdentityLinkInbound(
      { service: h.service, index: h.index },
      'feishu:user:ou_mallory',
      `确认绑定 ${pending.pending_id}`,
    );
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.committed).toBe(false);
    expect(res.reply).toContain('不是绑定请求');
    expect(h.index.resolve(FEISHU_KEY)).toBeNull();
    expect(h.service.getPending(pending.pending_id)?.status).toBe('pending');
  });

  it('reject keeps mapping unchanged and closes pending', async () => {
    const h = harness();
    const pending = await makePending(h);
    h.index.bind(FEISHU_KEY, 'feishu:user:ou_alice');

    const res = await tryHandleIdentityLinkInbound(
      { service: h.service, index: h.index },
      'feishu:user:ou_alice',
      `拒绝绑定 ${pending.pending_id}`,
    );
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.committed).toBe(false);
    expect(h.service.getPending(pending.pending_id)?.status).toBe('rejected');
    expect(h.index.resolve(FEISHU_KEY)).toBe('feishu:user:ou_alice');
  });

  it('unknown pending id reports gracefully', async () => {
    const h = harness();
    const res = await tryHandleIdentityLinkInbound(
      { service: h.service, index: h.index },
      'idp:user:alice',
      '确认绑定 not-a-real-id',
    );
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.committed).toBe(false);
    expect(res.reply).toContain('不存在或已失效');
  });
});
