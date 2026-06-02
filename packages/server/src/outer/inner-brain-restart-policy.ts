/**
 * 内脑手动 restart 准入（ADL：INNER-BRAIN-RESUME.md、inner-brain-exec-kill-resume-stuck P0）
 *
 * RUNNING 且 pid 仍存活 → 拒绝（409）
 * RUNNING 但 pid 已死 / 无 pid → 允许 respawn（磁盘 dyflow/legacy 状态续跑）
 */
import { isPidAlive } from '../pi-mono/inner-brain-spawner.js';
import type { TaskRecord, TaskStatus } from './inner-brain-registry.js';

const RESTARTABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'STOPPED',
  'ERROR',
  'AWAITING',
  'BLOCKED',
]);

export type RestartEligibility =
  | { allowed: true; reason: 'stopped' | 'dead_running' | 'awaiting_or_blocked' }
  | { allowed: false; reason: 'alive_running' | 'done' | 'unknown_status' };

export function evaluateInnerBrainRestart(record: TaskRecord): RestartEligibility {
  if (record.status === 'RUNNING') {
    if (record.pid != null && isPidAlive(record.pid)) {
      return { allowed: false, reason: 'alive_running' };
    }
    return { allowed: true, reason: 'dead_running' };
  }
  if (record.status === 'DONE') {
    return { allowed: false, reason: 'done' };
  }
  if (RESTARTABLE_STATUSES.has(record.status)) {
    return {
      allowed: true,
      reason: record.status === 'STOPPED' || record.status === 'ERROR' ? 'stopped' : 'awaiting_or_blocked',
    };
  }
  return { allowed: false, reason: 'unknown_status' };
}

export function restartEligibilityErrorMessage(id: string, el: RestartEligibility & { allowed: false }): string {
  switch (el.reason) {
    case 'alive_running':
      return `实例 ${id} 正在运行中（pid 存活），无需重启`;
    case 'done':
      return `实例 ${id} 已完成（DONE），请通过外脑 spawn 新 burst`;
    default:
      return `实例 ${id} 当前状态不可重启`;
  }
}
