/**
 * ADL: identityBindingIndex · P0b Facade 入站 canonicalize
 * path: packages/server/src/outer/inbound-sender-canonicalize.component.test.ts
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §4.3
 */
import { describe, expect, it } from 'vitest';
import {
  IdentityBindingIndex,
  canonicalizeInboundSenderSid,
  resolveInboundSenderSid,
} from '@utlra/chat-ir';

describe('component: inboundSenderCanonicalize (P0b)', () => {
  it('bridge-style resolve then facade canonicalize agree after linkMerge', () => {
    const index = new IdentityBindingIndex({ persistPath: null });
    const webKey = { channel: 'webchat', native_user_id: 'alice' };
    const feishuKey = { channel: 'feishu', native_user_id: 'ou_a', scope: 'cli_1' };

    const provisionalWeb = resolveInboundSenderSid(index, webKey, 'webchat:user:alice');
    expect(provisionalWeb).toBe('webchat:user:alice');

    // 模拟双边确认后 merge 到稳定 sid
    index.bind(feishuKey, 'idp:user:feishu-temp');
    index.linkMerge('idp:user:feishu-temp', 'webchat:user:alice');
    index.linkMerge('webchat:user:alice', 'idp:user:alice');

    expect(resolveInboundSenderSid(index, webKey, 'webchat:user:alice')).toBe('idp:user:alice');
    expect(canonicalizeInboundSenderSid(index, 'webchat:user:alice')).toBe('idp:user:alice');
    expect(resolveInboundSenderSid(index, feishuKey, 'feishu:user:ou_a')).toBe('idp:user:alice');
  });
});
