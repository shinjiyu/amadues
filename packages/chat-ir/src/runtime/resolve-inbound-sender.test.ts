/**
 * ADL: identityBindingIndex · P0b 入站 resolve
 */
import { describe, expect, it } from 'vitest';
import { IdentityBindingIndex } from './identity-binding-index.js';
import {
  canonicalizeInboundSenderSid,
  channelKeyFromProvisionalSid,
  resolveInboundSenderSid,
} from './resolve-inbound-sender.js';

describe('resolveInboundSenderSid', () => {
  it('without index returns provisional', () => {
    expect(
      resolveInboundSenderSid(null, { channel: 'webchat', native_user_id: 'a' }, 'webchat:user:a'),
    ).toBe('webchat:user:a');
  });

  it('first sight binds provisional; later returns same', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    const key = { channel: 'webchat', native_user_id: 'alice' };
    const a = resolveInboundSenderSid(idx, key, 'webchat:user:alice');
    expect(a).toBe('webchat:user:alice');
    expect(idx.resolve(key)).toBe('webchat:user:alice');
    expect(resolveInboundSenderSid(idx, key, 'webchat:user:alice')).toBe('webchat:user:alice');
  });

  it('after linkMerge returns canonical sid even if provisional is legacy', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    const web = { channel: 'webchat', native_user_id: 'alice' };
    const feishu = { channel: 'feishu', native_user_id: 'ou_a', scope: 'cli_1' };
    idx.bind(web, 'webchat:user:alice');
    idx.bind(feishu, 'idp:user:feishu-temp');
    idx.linkMerge('idp:user:feishu-temp', 'webchat:user:alice');
    idx.linkMerge('webchat:user:alice', 'idp:user:alice');

    expect(resolveInboundSenderSid(idx, web, 'webchat:user:alice')).toBe('idp:user:alice');
    expect(resolveInboundSenderSid(idx, feishu, 'feishu:user:ou_a')).toBe('idp:user:alice');
  });
});

describe('canonicalizeInboundSenderSid', () => {
  it('parses legacy webchat/discord sid and resolves', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    idx.bind({ channel: 'webchat', native_user_id: 'bob' }, 'idp:user:bob');
    expect(channelKeyFromProvisionalSid('webchat:user:bob')).toEqual({
      channel: 'webchat',
      native_user_id: 'bob',
    });
    expect(canonicalizeInboundSenderSid(idx, 'webchat:user:bob')).toBe('idp:user:bob');
    expect(canonicalizeInboundSenderSid(idx, 'idp:user:already')).toBe('idp:user:already');
  });
});
