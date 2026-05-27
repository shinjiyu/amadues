/**
 * 群聊主动发言冷却 / 频控（与 openKuroneko ParticipationEngine 对齐，进程内状态）。
 */

export interface GroupParticipationState {
  lastProactiveAt: number;
  proactiveCount5min: number;
  proactiveCountResetAt: number;
}

const stateByThread = new Map<string, GroupParticipationState>();

export function getGroupParticipationState(threadId: string): GroupParticipationState {
  let s = stateByThread.get(threadId);
  if (!s) {
    s = { lastProactiveAt: 0, proactiveCount5min: 0, proactiveCountResetAt: Date.now() };
    stateByThread.set(threadId, s);
  }
  return s;
}

/** 记录一次「主动发言」（群聊非 @ 且实际发出回复时调用） */
export function recordProactiveSpeak(threadId: string): void {
  const s = getGroupParticipationState(threadId);
  const now = Date.now();
  s.lastProactiveAt = now;
  s.proactiveCount5min++;
}

/** 开发/测试：清空频控状态（Participation Lab） */
export function resetGroupParticipationState(threadId?: string): void {
  if (threadId) {
    stateByThread.delete(threadId);
    return;
  }
  stateByThread.clear();
}
