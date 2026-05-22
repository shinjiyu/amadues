/**
 * 把 `POST /threads/:id/messages` 请求体装配成落库的结构化 parts。
 *
 * 优先级与合并规则：
 * 1. 若客户端直接给了 `parts`，则以它为准（认为客户端已经做好结构化），仍按 `mention_user_ids`
 *    去重补齐 mentions 列表；`attachment_ids` 仍可独立追加为 attachment parts。
 * 2. 否则用 `text` + `mention_user_ids` 解析：
 *    - 用户在 `text` 里写 `@DisplayName` 或 `@user_id`；服务端**不**做模糊匹配，
 *      只接受 `mention_user_ids` 显式给的用户。
 *    - 服务端找到这些用户的 display_name，把首次出现的 token（`@DisplayName` 或 `@user_id`）
 *      替换为 mention part；找不到 token 的，**追加**到末尾作为 mention（兜底）。
 * 3. `attachment_ids` 按顺序追加到 parts 尾部。
 *
 * 重建 `text` 字段（落库的 `message.text`）：把 parts 串成一段纯文本，便于客户端历史预览。
 */
import type { Attachment, Mention, MessagePart, User } from '@utlra/webchat-protocol';

export interface BuildPartsInput {
  text: string | undefined;
  parts: MessagePart[] | undefined;
  mentionUserIds: string[];
  attachments: Attachment[];
  resolveUser: (userId: string) => User | undefined;
}

export interface BuildPartsResult {
  parts: MessagePart[];
  text: string;
  mentions: Mention[];
}

export function buildParts(input: BuildPartsInput): BuildPartsResult {
  const mentionUsers: User[] = [];
  const seenMentionIds = new Set<string>();
  for (const uid of input.mentionUserIds) {
    if (seenMentionIds.has(uid)) continue;
    const u = input.resolveUser(uid);
    if (!u) continue;
    mentionUsers.push(u);
    seenMentionIds.add(uid);
  }

  let parts: MessagePart[];
  if (input.parts && input.parts.length > 0) {
    parts = [...input.parts];
    // 追加客户端没在 parts 里出现但在 mention_user_ids 中的 mention
    const inlineMentionIds = new Set<string>();
    for (const p of parts) {
      if (p.type === 'mention') inlineMentionIds.add(p.user_id);
    }
    for (const u of mentionUsers) {
      if (!inlineMentionIds.has(u.user_id)) {
        parts.push({ type: 'mention', user_id: u.user_id, display_name: u.display_name });
      }
    }
  } else {
    parts = buildPartsFromText(input.text ?? '', mentionUsers);
  }

  for (const a of input.attachments) {
    parts.push({ type: 'attachment', attachment: a });
  }

  const mentions: Mention[] = [];
  const mentionSeen = new Set<string>();
  for (const p of parts) {
    if (p.type === 'mention' && !mentionSeen.has(p.user_id)) {
      mentions.push({ user_id: p.user_id, display_name: p.display_name });
      mentionSeen.add(p.user_id);
    }
  }

  return { parts, mentions, text: renderText(parts) };
}

function buildPartsFromText(text: string, mentionUsers: User[]): MessagePart[] {
  if (mentionUsers.length === 0) {
    return text.length > 0 ? [{ type: 'text', text }] : [];
  }
  let remaining = text;
  const out: MessagePart[] = [];
  const consumed = new Set<string>();

  // 贪心匹配每个被 mention 的 user：先按 display_name 再按 user_id，找到第一个 occurrence 替换。
  // 简化处理：每个 user 至多匹配一次。
  for (const u of mentionUsers) {
    if (consumed.has(u.user_id)) continue;
    const tokens = [
      `@${u.display_name}`,
      `@${u.user_id}`,
    ];
    let matched = false;
    for (const token of tokens) {
      const idx = remaining.indexOf(token);
      if (idx < 0) continue;
      const before = remaining.slice(0, idx);
      const after = remaining.slice(idx + token.length);
      if (before.length > 0) out.push({ type: 'text', text: before });
      out.push({ type: 'mention', user_id: u.user_id, display_name: u.display_name });
      remaining = after;
      matched = true;
      consumed.add(u.user_id);
      break;
    }
    if (!matched) {
      // 兜底：消息正文里没找到 token，把 mention 追加到末尾
      // 在最后统一处理（保持 remaining 完整）
    }
  }

  if (remaining.length > 0) out.push({ type: 'text', text: remaining });

  for (const u of mentionUsers) {
    if (consumed.has(u.user_id)) continue;
    out.push({ type: 'mention', user_id: u.user_id, display_name: u.display_name });
  }

  return out;
}

function renderText(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === 'text') chunks.push(p.text);
    else if (p.type === 'mention') chunks.push(`@${p.display_name}`);
    else if (p.type === 'attachment') chunks.push(`[${p.attachment.name}]`);
  }
  return chunks.join('');
}
