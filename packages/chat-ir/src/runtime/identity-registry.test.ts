import { describe, expect, it } from 'vitest';
import { IdentityRegistry } from './identity-registry.js';
import { resolvePrimaryAgentSid } from '../agent-sid.js';
import { serializeIdentityPack } from '../serialize.js';

describe('IdentityContextPack [ROLES]', () => {
  it('serializeIdentityPack includes [ROLES] lines', () => {
    const reg = new IdentityRegistry(null);
    const primary = resolvePrimaryAgentSid();
    const pack = reg.packForThread('thread:t', 'default', 'group', [primary]);
    const s = serializeIdentityPack(pack);
    expect(s).toContain('[ROLES]');
    expect(s).toContain(`${primary}:`);
  });
});

describe('resolveMentionToken', () => {
  it('prefers identities with a preferred channel when names collide', () => {
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
      sid: 'discord:user:42',
      kind: 'human',
      display_name: 'shinjiyu',
      aliases: [],
      roles_in_tenant: ['member'],
      bindings: [{ channel: 'discord', native_user_id: '42' }],
      updated_at: new Date().toISOString(),
    });

    const res = reg.resolveMentionToken('shinjiyu', { preferredChannels: ['discord'] });
    expect(res).toMatchObject({ kind: 'unique', sid: 'discord:user:42' });
  });
});
