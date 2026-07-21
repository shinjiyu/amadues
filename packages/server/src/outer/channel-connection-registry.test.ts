/**
 * ADL: channelConnectionRegistry
 * path: packages/server/src/outer/channel-connection-registry.ts
 * horizon.in:  add/remove/list；boot load connections.json
 * horizon.out: connection 状态；fan-in 挂/摘 channel；agent bot binding
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5.2
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FanInChatIRChannel,
  IdentityBindingIndex,
  type ChatIRChannel,
  type ChatIROutboundBody,
} from '@utlra/chat-ir';
import {
  ChannelConnectionRegistry,
  type ChannelConnector,
} from './channel-connection-registry.js';

class FakeChannel implements ChatIRChannel {
  started = 0;
  destroyed = 0;
  start(): void {
    this.started++;
  }
  destroy(): void {
    this.destroyed++;
  }
  async postMessage(_threadId: string, _body: ChatIROutboundBody): Promise<void> {}
}

function harness(opts?: { connectFail?: boolean; secrets?: Record<string, string> }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-'));
  const fanIn = new FanInChatIRChannel({ onAgentMessage: async () => {} });
  fanIn.start();
  const index = new IdentityBindingIndex({ persistPath: null });
  const channels: FakeChannel[] = [];
  const connector: ChannelConnector = {
    async connect(record, secret) {
      if (opts?.connectFail) throw new Error('probe failed: invalid app_secret');
      const ch = new FakeChannel();
      channels.push(ch);
      return { channel: ch, botNativeId: `bot_${record.app_id}_${secret.length}` };
    },
  };
  const registry = new ChannelConnectionRegistry({
    persistPath: path.join(root, 'channels', 'connections.json'),
    fanIn,
    connectors: { feishu: connector },
    getSecret: async (ref) => opts?.secrets?.[ref] ?? null,
    bindingIndex: index,
    agentSid: 'idp:agent:assistant',
  });
  return { root, fanIn, index, registry, channels };
}

describe('ChannelConnectionRegistry', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('add connects, mounts on fan-in, binds bot key, persists', async () => {
    const h = harness({ secrets: { 'keychain/feishu_a': 's3cret' } });
    dirs.push(h.root);

    const res = await h.registry.add({
      kind: 'feishu',
      appId: 'cli_a',
      secretRef: 'keychain/feishu_a',
      addedBySid: 'idp:user:alice',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.status).toBe('up');
    expect(res.record.bot_native_id).toBe('bot_cli_a_6');
    expect(h.fanIn.listConnections()).toContain(res.record.connection_id);
    expect(h.channels[0].started).toBe(1);
    // bot key 绑到 agent sid
    expect(
      h.index.resolve({ channel: 'feishu', native_user_id: 'bot_cli_a_6', scope: 'cli_a' }),
    ).toBe('idp:agent:assistant');

    // 落盘不含 secret 明文
    const raw = fs.readFileSync(
      path.join(h.root, 'channels', 'connections.json'),
      'utf8',
    );
    expect(raw).toContain('cli_a');
    expect(raw).toContain('keychain/feishu_a');
    expect(raw).not.toContain('s3cret');
  });

  it('probe failure rolls back: nothing mounted, nothing persisted', async () => {
    const h = harness({ connectFail: true, secrets: { ref: 'x' } });
    dirs.push(h.root);

    const res = await h.registry.add({
      kind: 'feishu',
      appId: 'cli_bad',
      secretRef: 'ref',
      addedBySid: 'idp:user:alice',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('probe failed');
    expect(h.fanIn.listConnections()).toHaveLength(0);
    expect(h.registry.list()).toHaveLength(0);
  });

  it('missing secret / unknown kind are refused', async () => {
    const h = harness({ secrets: {} });
    dirs.push(h.root);

    const noSecret = await h.registry.add({
      kind: 'feishu',
      appId: 'cli_a',
      secretRef: 'keychain/nope',
      addedBySid: 'idp:user:a',
    });
    expect(noSecret.ok).toBe(false);
    if (!noSecret.ok) expect(noSecret.reason).toContain('secret');

    const badKind = await h.registry.add({
      kind: 'telegram',
      appId: 'x',
      secretRef: 'ref',
      addedBySid: 'idp:user:a',
    });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.reason).toContain('connector');
  });

  it('duplicate app is refused; remove unmounts and persists removal', async () => {
    const h = harness({ secrets: { ref: 'secret' } });
    dirs.push(h.root);

    const first = await h.registry.add({
      kind: 'feishu',
      appId: 'cli_a',
      secretRef: 'ref',
      addedBySid: 'idp:user:a',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const dup = await h.registry.add({
      kind: 'feishu',
      appId: 'cli_a',
      secretRef: 'ref',
      addedBySid: 'idp:user:a',
    });
    expect(dup.ok).toBe(false);

    const removed = await h.registry.remove(first.record.connection_id);
    expect(removed).toBe(true);
    expect(h.fanIn.listConnections()).toHaveLength(0);
    expect(h.channels[0].destroyed).toBe(1);
    expect(h.registry.list()).toHaveLength(0);
    expect(await h.registry.remove(first.record.connection_id)).toBe(false);
  });

  it('bootLoad reconnects persisted records; failures marked down without unmounting others', async () => {
    const h = harness({ secrets: { ref: 'secret' } });
    dirs.push(h.root);
    const added = await h.registry.add({
      kind: 'feishu',
      appId: 'cli_a',
      secretRef: 'ref',
      addedBySid: 'idp:user:a',
    });
    expect(added.ok).toBe(true);

    // 新进程：同 persistPath，重新 bootLoad
    const fanIn2 = new FanInChatIRChannel({ onAgentMessage: async () => {} });
    fanIn2.start();
    const channels2: FakeChannel[] = [];
    const registry2 = new ChannelConnectionRegistry({
      persistPath: path.join(h.root, 'channels', 'connections.json'),
      fanIn: fanIn2,
      connectors: {
        feishu: {
          async connect() {
            const ch = new FakeChannel();
            channels2.push(ch);
            return { channel: ch };
          },
        },
      },
      getSecret: async () => 'secret',
      agentSid: 'idp:agent:assistant',
    });
    await registry2.bootLoad();
    expect(registry2.list()).toHaveLength(1);
    expect(registry2.list()[0].status).toBe('up');
    expect(fanIn2.listConnections()).toHaveLength(1);

    // 失败场景：secret 取不到 → down，但记录保留
    const fanIn3 = new FanInChatIRChannel({ onAgentMessage: async () => {} });
    const registry3 = new ChannelConnectionRegistry({
      persistPath: path.join(h.root, 'channels', 'connections.json'),
      fanIn: fanIn3,
      connectors: { feishu: { async connect() { throw new Error('no'); } } },
      getSecret: async () => null,
      agentSid: 'idp:agent:assistant',
    });
    await registry3.bootLoad();
    expect(registry3.list()).toHaveLength(1);
    expect(registry3.list()[0].status).toBe('down');
    expect(fanIn3.listConnections()).toHaveLength(0);
  });
});
