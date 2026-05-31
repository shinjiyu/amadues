/**
 * 把 `POST /threads/:id/messages` 请求体装配成落库的结构化 parts。
 *
 * 优先级与合并规则：
 * 1. 若客户端直接给了 `parts`，则以它为准（认为客户端已经做好结构化），仍按 `mention_user_ids`
 *    去重补齐 mentions 列表；`attachment_ids` 仍可独立追加为 attachment parts。
 * 2. 否则用 `text` + `mention_user_ids` 解析：
 *    - 用户在 `text` 里写 `@DisplayName` 或 `@user_id`；服务端按 **完整 token 精确匹配**
 *      （大小写不敏感），禁止子串匹配（避免 `@Kuroneko` 误命中 `Kuro`）。
 *    - 正文中无 `@` 时，才将 `mention_user_ids` 里未匹配的用户追加到末尾（UI 选人兜底）。
 * 3. `attachment_ids` 按顺序追加到 parts 尾部。
 *
 * 重建 `text` 字段（落库的 `message.text`）：把 parts 串成一段纯文本，便于客户端历史预览。
 */
import type { Attachment, Mention, MessagePart, User } from '@utlra/webchat-protocol';
import { mentionTokenMatchesUser, normalizeMentionToken } from '@utlra/webchat-protocol';

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

  const out: MessagePart[] = [];
  const consumed = new Set<string>();
  const re = /@([^\s@]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const hasAtTokens = re.test(text);
  re.lastIndex = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ type: 'text', text: text.slice(last, m.index) });
    }
    const token = normalizeMentionToken(m[1]!);
    const matched = mentionUsers.find((u) => mentionTokenMatchesUser(token, u));
    if (matched) {
      out.push({ type: 'mention', user_id: matched.user_id, display_name: matched.display_name });
      consumed.add(matched.user_id);
    } else {
      out.push({ type: 'text', text: m[0]! });
    }
    last = m.index + m[0]!.length;
  }

  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });

  // 正文无 @ 时：允许 mention_user_ids 兜底追加（例如 UI 选人但未打 @）
  if (!hasAtTokens) {
    for (const u of mentionUsers) {
      if (consumed.has(u.user_id)) continue;
      out.push({ type: 'mention', user_id: u.user_id, display_name: u.display_name });
    }
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
