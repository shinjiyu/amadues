/**
 * `reply.v1` → `MessagePart[]`。
 *
 * 协议：`doc/protocols/inner-brain-deliverables.md` §6 / `doc/chat-ir-identity-design.md` §5.2.1
 */
import type {
  ChatAssetStore,
  IdentityRegistry,
  MessagePart,
  StructuredReply,
} from '@utlra/chat-ir';
import { expandAttachAssetIds } from './attach-expand.js';

function materializeReplyMentionParts(
  reply: StructuredReply,
  registry?: IdentityRegistry,
): MessagePart[] {
  const existing = new Set(
    (reply.parts ?? [])
      .filter((part): part is Extract<MessagePart, { type: 'mention' }> => part.type === 'mention')
      .map((part) => part.target_sid),
  );
  const mentionSids = reply.mention_sids.filter((sid) => !existing.has(sid));
  if (mentionSids.length === 0) return [];

  const parts: MessagePart[] = [];
  for (const sid of mentionSids) {
    if (parts.length > 0) parts.push({ type: 'text', text: ' ' });
    parts.push({
      type: 'mention',
      target_sid: sid,
      label: registry?.get(sid)?.display_name,
    });
  }
  return parts;
}

export function structuredReplyToMessageParts(
  reply: StructuredReply,
  assetStore?: ChatAssetStore,
  logDir?: string,
  registry?: IdentityRegistry,
): MessagePart[] {
  const base: MessagePart[] =
    reply.parts?.length
      ? [...reply.parts]
      : reply.text?.trim()
        ? [{ type: 'text', text: reply.text.trim() }]
        : [];
  const mentionParts = materializeReplyMentionParts(reply, registry);
  const body =
    mentionParts.length === 0
      ? base
      : base.length === 0
        ? mentionParts
        : [...mentionParts, { type: 'text', text: ' ' } as MessagePart, ...base];

  if (!assetStore || !reply.attach_asset_ids?.length) return body;

  const expanded = expandAttachAssetIds(reply.attach_asset_ids, assetStore, { logDir });
  return [...body, ...expanded.parts];
}
