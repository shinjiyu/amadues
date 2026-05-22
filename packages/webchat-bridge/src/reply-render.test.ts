import { describe, expect, it } from 'vitest';
import { IdentityRegistry } from '@utlra/chat-ir';
import type { MessagePart } from '@utlra/chat-ir';
import { renderForWebChat } from './reply-render.js';

function freshRegistry(): IdentityRegistry {
  return new IdentityRegistry(null);
}

describe('renderForWebChat', () => {
  it('renders text parts and quote as reply_to', () => {
    const reg = freshRegistry();
    const parts: MessagePart[] = [
      { type: 'text', text: 'hi' },
      { type: 'quote', quoted_message_id: 'webchat:abc-123' },
    ];
    const r = renderForWebChat({
      parts,
      registry: reg,
      uploadedAssetByUri: new Map(),
    });
    expect(r.text).toBe('hi');
    expect(r.parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect(r.replyToMessageId).toBe('abc-123');
  });

  it('resolves mention via registry binding', () => {
    const reg = freshRegistry();
    reg.upsert({
      schema: 'identity.v1',
      sid: 'webchat:user:bob',
      kind: 'human',
      display_name: 'Bob',
      aliases: [],
      roles_in_tenant: ['member'],
      bindings: [{ channel: 'webchat', native_user_id: 'bob' }],
      updated_at: new Date().toISOString(),
    });
    const r = renderForWebChat({
      parts: [
        { type: 'text', text: 'yo ' },
        { type: 'mention', target_sid: 'webchat:user:bob', label: 'Bob' },
      ],
      registry: reg,
      uploadedAssetByUri: new Map(),
    });
    expect(r.text).toBe('yo @Bob');
    expect(r.mentionUserIds).toEqual(['bob']);
  });

  it('falls back to text when mention sid is unknown', () => {
    const reg = freshRegistry();
    const r = renderForWebChat({
      parts: [{ type: 'mention', target_sid: 'discord:user:42', label: 'someone' }],
      registry: reg,
      uploadedAssetByUri: new Map(),
    });
    expect(r.mentionUserIds).toEqual([]);
    expect(r.text).toBe('@someone');
  });

  it('uses uploaded asset map for attachments and surfaces pending uris', () => {
    const reg = freshRegistry();
    const uploaded = new Map([['asset:my-uuid', 'cs-asset-1']]);
    const r = renderForWebChat({
      parts: [
        { type: 'attachment', asset_ref: { kind: 'image', uri: 'asset:my-uuid', mime: 'image/png', name: 'a.png' } },
        { type: 'attachment', asset_ref: { kind: 'file', uri: 'asset:other', mime: 'application/pdf', name: 'b.pdf' } },
      ],
      registry: reg,
      uploadedAssetByUri: uploaded,
    });
    expect(r.attachmentIds).toEqual(['cs-asset-1']);
    expect(r.pendingAssetUris).toEqual(['asset:other']);
  });
});
