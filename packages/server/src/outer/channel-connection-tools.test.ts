/**
 * ADL: channelConnectionRegistry · 外脑工具
 * path: packages/server/src/outer/channel-connection-tools.ts
 * horizon.in:  feishu_channel_add / list / remove tool calls
 * horizon.out: 连接热插（经 registry）；admin 闸
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5.2
 */
import { describe, expect, it } from 'vitest';
import {
  FanInChatIRChannel,
  IdentityBindingIndex,
  type ChatIRChannel,
  type ChatIROutboundBody,
} from '@utlra/chat-ir';
import { ChannelConnectionRegistry } from './channel-connection-registry.js';
import {
  CHANNEL_CONNECTION_TOOL_DEFS,
  dispatchChannelConnectionTool,
} from './channel-connection-tools.js';
import { OUTER_TOOL_DEFS, type OuterToolContext } from './outer-tools.js';

class FakeChannel implements ChatIRChannel {
  start(): void {}
  destroy(): void {}
  async postMessage(_t: string, _b: ChatIROutboundBody): Promise<void> {}
}

function harness(opts?: {
  actor?: string;
  admins?: string[];
  secrets?: Record<string, string>;
  bindingIndex?: IdentityBindingIndex;
}) {
  const fanIn = new FanInChatIRChannel({ onAgentMessage: async () => {} });
  fanIn.start();
  const registry = new ChannelConnectionRegistry({
    persistPath: null,
    fanIn,
    connectors: {
      feishu: {
        async connect(record) {
          return { channel: new FakeChannel(), botNativeId: `bot_${record.app_id}` };
        },
      },
    },
    getSecret: async (ref) => opts?.secrets?.[ref] ?? null,
    agentSid: 'idp:agent:assistant',
  });
  const ctx = {
    channelConnectionRegistry: registry,
    channelAdminSids: new Set(opts?.admins ?? []),
    inboundHumanSid: opts?.actor,
    bindingIndex: opts?.bindingIndex ?? null,
  } as unknown as OuterToolContext;
  return { fanIn, registry, ctx };
}

describe('channel-connection-tools', () => {
  it('tool defs are registered in OUTER_TOOL_DEFS', () => {
    const names = OUTER_TOOL_DEFS.map((d) => d.function.name);
    for (const def of CHANNEL_CONNECTION_TOOL_DEFS) {
      expect(names).toContain(def.function.name);
    }
  });

  it('non-admin add is denied; admin add mounts connection', async () => {
    const h = harness({
      actor: 'idp:user:alice',
      admins: ['idp:user:root'],
      secrets: { feishu_a: 's' },
    });
    const denied = await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_a', secret_ref: 'feishu_a' },
      h.ctx,
    );
    expect(denied!.output).toContain('白名单');
    expect(h.registry.list()).toHaveLength(0);

    const h2 = harness({
      actor: 'idp:user:root',
      admins: ['idp:user:root'],
      secrets: { feishu_a: 's' },
    });
    const ok = await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_a', secret_ref: 'feishu_a' },
      h2.ctx,
    );
    expect(ok!.output).toContain('已建立');
    expect(h2.registry.list()).toHaveLength(1);
    expect(h2.fanIn.listConnections()).toHaveLength(1);
  });

  it('admin 判定经 bindingIndex 折叠：白名单写渠道形式 SID，同人 canonical/新渠道入站也放行', async () => {
    // 场景：.env 配的是 webchat:user:yzy；该 key 已 linkMerge 到 canonical idp:user:CANON。
    const index = new IdentityBindingIndex();
    index.bind({ channel: 'webchat', native_user_id: 'yzy' }, 'idp:user:CANON');
    index.bind({ channel: 'feishu', native_user_id: 'on_yzy', scope: 'cli_a' }, 'idp:user:CANON');

    // 入站 sender 已被 OuterBrain canonicalize 为 idp:user:CANON（无论来自 webchat 还是新飞书）
    const h = harness({
      actor: 'idp:user:CANON',
      admins: ['webchat:user:yzy'],
      secrets: { feishu_b: 's' },
      bindingIndex: index,
    });
    const ok = await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_b', secret_ref: 'feishu_b' },
      h.ctx,
    );
    expect(ok!.output).toContain('已建立');

    // 无关人员仍被拒
    const stranger = harness({
      actor: 'idp:user:MALLORY',
      admins: ['webchat:user:yzy'],
      secrets: { feishu_b: 's' },
      bindingIndex: index,
    });
    const denied = await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_b', secret_ref: 'feishu_b' },
      stranger.ctx,
    );
    expect(denied!.output).toContain('白名单');
  });

  it("白名单 '*' = 显式放开（任何人类入站可管理；仍拒非 IM 入站）", async () => {
    const h = harness({ actor: 'feishu:user:on_stranger', admins: ['*'], secrets: { k: 's' } });
    const ok = await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_x', secret_ref: 'k' },
      h.ctx,
    );
    expect(ok!.output).toContain('已建立');

    const noHuman = harness({ admins: ['*'], secrets: { k: 's' } });
    const denied = await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_x', secret_ref: 'k' },
      noHuman.ctx,
    );
    expect(denied!.output).toContain('人类 IM 入站');
  });

  it('add failure surfaces reason (rolled back)', async () => {
    const h = harness({ actor: 'idp:user:root', admins: ['idp:user:root'], secrets: {} });
    const res = await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_a', secret_ref: 'missing' },
      h.ctx,
    );
    expect(res!.output).toContain('失败');
    expect(res!.output).toContain('secret');
  });

  it('list shows records; remove needs admin and unmounts', async () => {
    const h = harness({
      actor: 'idp:user:root',
      admins: ['idp:user:root'],
      secrets: { feishu_a: 's' },
    });
    await dispatchChannelConnectionTool(
      'feishu_channel_add',
      { app_id: 'cli_a', secret_ref: 'feishu_a' },
      h.ctx,
    );
    const rec = h.registry.list()[0];

    const list = await dispatchChannelConnectionTool('feishu_channel_list', {}, h.ctx);
    expect(list!.output).toContain(rec.connection_id);
    expect(list!.output).toContain('[up]');

    const removed = await dispatchChannelConnectionTool(
      'feishu_channel_remove',
      { connection_id: rec.connection_id },
      h.ctx,
    );
    expect(removed!.output).toContain('已摘除');
    expect(h.registry.list()).toHaveLength(0);
    expect(h.fanIn.listConnections()).toHaveLength(0);
  });

  it('unknown tool name returns null', async () => {
    const h = harness();
    expect(await dispatchChannelConnectionTool('reply_to_user', {}, h.ctx)).toBeNull();
  });
});
