/**
 * thread_id 工具 —— chat-server 与适配器都用同一套规则，不留二义性。
 *
 * - 大群：`global`（可通过 env 覆盖；本模块只暴露默认常量）
 * - DM：`dm:<userA>:<userB>`，其中 `userA < userB` 字典序，保证任意双人对 → 唯一 thread_id
 */

export const DEFAULT_GLOBAL_THREAD_ID = 'global';

export function isDmThreadId(threadId: string): boolean {
  return threadId.startsWith('dm:');
}

/**
 * 生成两人 DM 的稳定 thread_id。
 *
 * @throws Error 如果 userA === userB。
 */
export function dmThreadId(userA: string, userB: string): string {
  if (!userA || !userB) throw new Error('dmThreadId: empty user_id');
  if (userA === userB) throw new Error('dmThreadId: cannot DM yourself');
  const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
  return `dm:${a}:${b}`;
}

/**
 * 解析 DM thread_id 还原两个 user_id；非 DM 形式返回 null。
 */
export function parseDmThreadId(threadId: string): [string, string] | null {
  if (!threadId.startsWith('dm:')) return null;
  const rest = threadId.slice(3);
  // user_id 不允许包含冒号；按第一个冒号拆分
  const idx = rest.indexOf(':');
  if (idx < 0) return null;
  const a = rest.slice(0, idx);
  const b = rest.slice(idx + 1);
  if (!a || !b) return null;
  return [a, b];
}

/**
 * 判断给定的 user_id 是否属于该线程的参与者（仅基于 thread_id 形态判断 DM）。
 * 群组 thread 的参与者需要查 store，本函数不处理。
 */
export function isDmParticipant(threadId: string, userId: string): boolean {
  const pair = parseDmThreadId(threadId);
  if (!pair) return false;
  return pair[0] === userId || pair[1] === userId;
}
