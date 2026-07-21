/**
 * ADL: identityLinkService · 外脑工具
 * path: packages/server/src/outer/identity-link-tools.ts
 * horizon.in:  identity_link_request / identity_link_status tool calls
 * horizon.out: pending 创建 + 确认指引文案
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §4.2
 */
import { describe, expect, it } from 'vitest';
import { IdentityBindingIndex } from '@utlra/chat-ir';
import { createIdentityLinkService } from './identity-link-service.js';
import {
  IDENTITY_LINK_TOOL_DEFS,
  dispatchIdentityLinkTool,
} from './identity-link-tools.js';
import { OUTER_TOOL_DEFS, type OuterToolContext } from './outer-tools.js';

function harness(opts?: { inboundHumanSid?: string }) {
  const index = new IdentityBindingIndex({ persistPath: null });
  const service = createIdentityLinkService({ index, pendingDir: null });
  const ctx = {
    identityLinkService: service,
    bindingIndex: index,
    inboundHumanSid: opts?.inboundHumanSid,
  } as unknown as OuterToolContext;
  return { index, service, ctx };
}

describe('identity-link-tools', () => {
  it('tool defs are registered in OUTER_TOOL_DEFS', () => {
    const names = OUTER_TOOL_DEFS.map((d) => d.function.name);
    for (const def of IDENTITY_LINK_TOOL_DEFS) {
      expect(names).toContain(def.function.name);
    }
  });

  it('identity_link_request creates pending and returns confirm instructions', async () => {
    const h = harness({ inboundHumanSid: 'idp:user:alice' });
    h.index.bind({ channel: 'webchat', native_user_id: 'alice' }, 'idp:user:alice');

    const res = await dispatchIdentityLinkTool(
      'identity_link_request',
      { counterpart_channel: 'feishu', counterpart_native_id: 'ou_alice', scope: 'cli_1' },
      h.ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.output).toContain('确认绑定');
    const pending = h.service.list()[0];
    expect(pending).toBeDefined();
    expect(res!.output).toContain(pending.pending_id);
    expect(pending.counterpart_key).toEqual({
      channel: 'feishu',
      native_user_id: 'ou_alice',
      scope: 'cli_1',
    });
    // 未确认前映射不变
    expect(h.index.resolve(pending.counterpart_key)).toBeNull();
  });

  it('identity_link_request refuses without inbound human', async () => {
    const h = harness();
    const res = await dispatchIdentityLinkTool(
      'identity_link_request',
      { counterpart_channel: 'feishu', counterpart_native_id: 'ou_x' },
      h.ctx,
    );
    expect(res!.output).toContain('人类 IM 入站');
    expect(h.service.list()).toHaveLength(0);
  });

  it('identity_link_request refuses when initiator has no bound keys', async () => {
    const h = harness({ inboundHumanSid: 'idp:user:ghost' });
    const res = await dispatchIdentityLinkTool(
      'identity_link_request',
      { counterpart_channel: 'feishu', counterpart_native_id: 'ou_x' },
      h.ctx,
    );
    expect(res!.output).toContain('没有任何渠道绑定');
  });

  it('identity_link_request surfaces already-bound-to-other failure', async () => {
    const h = harness({ inboundHumanSid: 'idp:user:alice' });
    h.index.bind({ channel: 'webchat', native_user_id: 'alice' }, 'idp:user:alice');
    h.index.bind({ channel: 'feishu', native_user_id: 'ou_x', scope: 'cli_1' }, 'idp:user:other');

    const res = await dispatchIdentityLinkTool(
      'identity_link_request',
      { counterpart_channel: 'feishu', counterpart_native_id: 'ou_x', scope: 'cli_1' },
      h.ctx,
    );
    expect(res!.output).toContain('counterpart_key_already_bound');
  });

  it('identity_link_status shows single pending and filtered list', async () => {
    const h = harness({ inboundHumanSid: 'idp:user:alice' });
    h.index.bind({ channel: 'webchat', native_user_id: 'alice' }, 'idp:user:alice');
    await dispatchIdentityLinkTool(
      'identity_link_request',
      { counterpart_channel: 'feishu', counterpart_native_id: 'ou_alice' },
      h.ctx,
    );
    const pending = h.service.list()[0];

    const single = await dispatchIdentityLinkTool(
      'identity_link_status',
      { pending_id: pending.pending_id },
      h.ctx,
    );
    expect(single!.output).toContain(pending.pending_id);
    expect(single!.output).toContain('[pending]');

    const list = await dispatchIdentityLinkTool('identity_link_status', {}, h.ctx);
    expect(list!.output).toContain(pending.pending_id);
  });

  it('unknown tool name returns null', async () => {
    const h = harness();
    expect(await dispatchIdentityLinkTool('memory_block_list', {}, h.ctx)).toBeNull();
  });
});
