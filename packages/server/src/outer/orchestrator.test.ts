import { describe, expect, it } from 'vitest';
import { IdentityRegistry, StructuredReplySchema } from '@utlra/chat-ir';
import { structuredReplyToMessageParts } from './orchestrator.js';

describe('structuredReplyToMessageParts', () => {
  it('materializes top-level mention_sids into mention parts', () => {
    const registry = new IdentityRegistry(null);
    registry.upsert({
      schema: 'identity.v1',
      sid: 'discord:user:123456',
      kind: 'human',
      display_name: 'shinjiyu',
      aliases: [],
      roles_in_tenant: ['member'],
      bindings: [{ channel: 'discord', native_user_id: '123456' }],
      updated_at: new Date().toISOString(),
    });

    const reply = StructuredReplySchema.parse({
      schema: 'reply.v1',
      thread_id: 'thread:discord:test',
      text: 'hello there',
      mention_sids: ['discord:user:123456'],
    });

    expect(structuredReplyToMessageParts(reply, undefined, undefined, registry)).toEqual([
      { type: 'mention', target_sid: 'discord:user:123456', label: 'shinjiyu' },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'hello there' },
    ]);
  });
});
