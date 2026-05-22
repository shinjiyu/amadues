/**
 * 出站翻译：Chat IR `MessagePart[]` → chat-server `PostMessageRequest`。
 *
 * IR mention `target_sid` → chat-server `mention_user_ids: [user_id]`
 * IR attachment `asset_ref.uri` → 看 URI 形态：
 *   - `chatserver://...` 已上传的 chat-server asset → 直接复用 asset_id
 *   - 其他（asset:<uuid> / http(s)://...）→ 需要上传到 chat-server 才能附在消息上
 *
 * 当 IR 出站需要把附件 attach 到 chat-server 消息时（asset_ref 是本地 ChatAssetStore URI 或
 * 任意外链），必须先调 chat-server `/uploads` 拿到 asset_id；这步在 `webchat-channel.ts`
 * 里完成，本模块只负责**确定要上传哪些**。
 *
 * Reply：IR 的 `reply_to_message_id`（如有，由 `MessageRecord` 字段）形如 `webchat:<uuid>`，
 * 拆掉前缀就是 chat-server 的 message_id；由调用方拆好后传进 `PostMessageRequest.reply_to_message_id`。
 */
import type { MessagePart } from '@utlra/chat-ir';
import type {
  PostMessageRequest,
  MessagePart as WebChatPart,
} from '@utlra/webchat-protocol';
import type { IdentityRegistry } from '@utlra/chat-ir';
import { sidToWebChatUserId } from './identity-mapper.js';

export interface RenderInput {
  parts: MessagePart[];
  registry: IdentityRegistry;
  /** 出站附件 IR `asset_ref.uri` → 已上传的 chat-server `asset_id` 的映射（由 channel 预先填好） */
  uploadedAssetByUri: Map<string, string>;
}

export interface RenderResult {
  text: string;
  parts: WebChatPart[];
  mentionUserIds: string[];
  attachmentIds: string[];
  /** 入站 IR `asset_ref.uri` 中**未在 `uploadedAssetByUri` 命中**的部分（调用方需要先上传） */
  pendingAssetUris: string[];
  /** 由 IR `quote` part 提取的 chat-server message_id（去掉 `webchat:` 前缀） */
  replyToMessageId: string | undefined;
}

export function renderForWebChat(input: RenderInput): RenderResult {
  const out: WebChatPart[] = [];
  const mentionUserIds: string[] = [];
  const attachmentIds: string[] = [];
  const pendingAssetUris: string[] = [];
  const textChunks: string[] = [];
  const mentionSet = new Set<string>();
  let replyToMessageId: string | undefined;

  for (const p of input.parts) {
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text });
      textChunks.push(p.text);
    } else if (p.type === 'mention') {
      const userId = sidToWebChatUserId(p.target_sid, input.registry);
      if (userId) {
        const displayName = input.registry.get(p.target_sid)?.display_name ?? p.label ?? userId;
        out.push({ type: 'mention', user_id: userId, display_name: displayName });
        if (!mentionSet.has(userId)) {
          mentionSet.add(userId);
          mentionUserIds.push(userId);
        }
        textChunks.push(`@${displayName}`);
      } else {
        // 不能解析到 webchat 用户：保留为纯文本占位（防止信息丢失）
        const fallback = `@${p.label ?? p.target_sid}`;
        out.push({ type: 'text', text: fallback });
        textChunks.push(fallback);
      }
    } else if (p.type === 'attachment') {
      const uri = p.asset_ref.uri;
      const knownAssetId = input.uploadedAssetByUri.get(uri);
      if (knownAssetId) {
        attachmentIds.push(knownAssetId);
      } else {
        pendingAssetUris.push(uri);
      }
      textChunks.push(`[${p.asset_ref.name ?? 'file'}]`);
    } else if (p.type === 'quote') {
      // IR quote → chat-server reply_to_message_id（取第一个 quote）
      if (!replyToMessageId) {
        const irQuoted = p.quoted_message_id;
        replyToMessageId = irQuoted.startsWith('webchat:')
          ? irQuoted.slice('webchat:'.length)
          : irQuoted;
      }
    }
  }

  return {
    text: textChunks.join('').trim(),
    parts: out,
    mentionUserIds,
    attachmentIds,
    pendingAssetUris,
    replyToMessageId,
  };
}
