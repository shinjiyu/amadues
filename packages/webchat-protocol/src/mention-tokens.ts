/**
 * @ 提及 token 解析 — web-chat 与 chat-server 共用。
 *
 * 必须用完整 token 精确匹配（大小写不敏感），禁止子串 includes，
 * 否则 `@Kuroneko` 会误命中 display_name 为 `Kuro` 的用户。
 */

export interface MentionMatchUser {
  user_id: string;
  display_name: string;
}

/** 去掉 @token 尾部常见标点，便于 `@Bob,` 匹配 display_name `Bob`。 */
export function normalizeMentionToken(raw: string): string {
  return raw.trim().replace(/[,.!?;:，。！？：；]+$/u, '');
}

/** 从正文中提取 `@token`（不含 `@`，已 normalize）。 */
export function extractMentionTokens(text: string): string[] {
  const tokens: string[] = [];
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = normalizeMentionToken(m[1]!);
    if (t) tokens.push(t);
  }
  return tokens;
}

export function mentionTokenMatchesUser(token: string, user: MentionMatchUser): boolean {
  const lower = token.toLowerCase();
  return user.display_name.toLowerCase() === lower || user.user_id.toLowerCase() === lower;
}

/** 按正文里的 @token 精确匹配 user_id（去重，保序）。 */
export function resolveMentionUserIdsFromText(
  text: string,
  users: MentionMatchUser[],
  excludeUserId?: string,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const token of extractMentionTokens(text)) {
    for (const u of users) {
      if (excludeUserId && u.user_id === excludeUserId) continue;
      if (!mentionTokenMatchesUser(token, u)) continue;
      if (seen.has(u.user_id)) break;
      seen.add(u.user_id);
      ids.push(u.user_id);
      break;
    }
  }
  return ids;
}
