import type { UserPresence } from '@utlra/webchat-protocol';

/** 已知 Agent（WebChat user_id），@ 时优先展示 */
const AGENT_USER_IDS = new Set(['kuroneko', 'shiro', 'gin']);

/** 测试/探针账号，不在 @ 与成员栏展示 */
export function isMentionNoiseUser(u: UserPresence, meUserId: string): boolean {
  if (u.user_id === meUserId) return true;
  const id = u.user_id;
  const name = u.display_name;
  if (id === 'probe') return true;
  if (id.startsWith('harvest-node-')) return true;
  if (id.startsWith('spoofed-')) return true;
  if (/^0{16,}/.test(id)) return true;
  if (id.startsWith('user_') || name.startsWith('user_')) return true;
  return false;
}

function mentionRank(u: UserPresence): number {
  let score = 0;
  if (u.online) score += 100;
  if (AGENT_USER_IDS.has(u.user_id)) score += 40;
  return score;
}

/** 在线优先 → Agent → 显示名 */
export function sortMentionCandidates(users: UserPresence[]): UserPresence[] {
  return [...users].sort((a, b) => {
    const d = mentionRank(b) - mentionRank(a);
    if (d !== 0) return d;
    return a.display_name.localeCompare(b.display_name, 'zh');
  });
}

export function filterMentionCandidates(
  users: UserPresence[],
  meUserId: string,
  query: string,
  limit = 8,
): UserPresence[] {
  const q = query.toLowerCase();
  return sortMentionCandidates(users)
    .filter((u) => !isMentionNoiseUser(u, meUserId))
    .filter(
      (u) =>
        u.display_name.toLowerCase().includes(q) || u.user_id.toLowerCase().includes(q),
    )
    .slice(0, limit);
}

/** 成员侧栏：隐藏探针账号，在线仍排前 */
export function sortSidebarUsers(users: UserPresence[], meUserId: string): UserPresence[] {
  return sortMentionCandidates(users.filter((u) => !isMentionNoiseUser(u, meUserId)));
}
