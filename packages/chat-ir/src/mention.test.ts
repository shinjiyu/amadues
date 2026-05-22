import { describe, expect, it } from 'vitest';
import { IdentityRegistry } from './runtime/identity-registry.js';
import { resolvePrimaryAgentSid } from './agent-sid.js';
import { plainTextToPartsWithMentions } from './mention.js';

describe('plainTextToPartsWithMentions', () => {
  it('resolves @alias to mention part', () => {
    const reg = new IdentityRegistry(null);
    const parts = plainTextToPartsWithMentions('你好 @助手 帮忙', reg);
    const mentions = parts.filter((p) => p.type === 'mention');
    expect(mentions.length).toBe(1);
    expect(mentions[0]).toMatchObject({ type: 'mention', target_sid: resolvePrimaryAgentSid() });
  });

  it('leaves unknown @ as text', () => {
    const reg = new IdentityRegistry(null);
    const parts = plainTextToPartsWithMentions('@不存在的人', reg);
    expect(parts.every((p) => p.type === 'text')).toBe(true);
  });

  it('prefers current thread participants over same-name identities', () => {
    const reg = new IdentityRegistry(null);
    reg.upsert({
      schema: 'identity.v1',
      sid: 'idp:user:shinjiyu',
      kind: 'human',
      display_name: 'shinjiyu',
      aliases: [],
      roles_in_tenant: ['member'],
      bindings: [{ channel: 'web', native_user_id: 'shinjiyu' }],
      updated_at: new Date().toISOString(),
    });
    reg.upsert({
      schema: 'identity.v1',
      sid: 'discord:user:123456',
      kind: 'human',
      display_name: 'shinjiyu',
      aliases: [],
      roles_in_tenant: ['member'],
      bindings: [{ channel: 'discord', native_user_id: '123456' }],
      updated_at: new Date().toISOString(),
    });

    const parts = plainTextToPartsWithMentions('hi @shinjiyu', reg, {
      participantSids: [resolvePrimaryAgentSid(), 'discord:user:123456'],
      preferredChannels: ['discord'],
    });
    const mentions = parts.filter((p) => p.type === 'mention');
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ type: 'mention', target_sid: 'discord:user:123456' });
  });
});
