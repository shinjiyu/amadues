/**
 * 统一停止内脑实例：RUNNING / AWAITING / BLOCKED 均可停。
 * ask_user 挂起时 registry 为 AWAITING 且子进程可能仍存活，需 SIGTERM + 取消 pending。
 */
import fs from 'node:fs';
import path from 'node:path';

import { writeStopSignal } from '../pi-mono/run-tick.js';
import { isPidAlive } from '../pi-mono/inner-brain-spawner.js';
import {
  listActivePendings,
  listUnconsumedResolved,
  markConsumed,
  resolvePending,
} from '../openkuroneko/pendings/index.js';
import type { InnerBrainRegistry, TaskRecord, TaskStatus } from './inner-brain-registry.js';

const STOPPABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['RUNNING', 'AWAITING', 'BLOCKED']);

export function isInnerBrainStoppable(status: TaskStatus): boolean {
  return STOPPABLE_STATUSES.has(status);
}

/** 停止单条任务；返回人类可读动作摘要（供日志 / 工具 output） */
export function stopInnerBrainInstance(
  record: TaskRecord,
  registry: InnerBrainRegistry,
  reason = 'stopped by user/agent',
): { ok: true; priorStatus: TaskStatus; actions: string[] } | { ok: false; message: string } {
  if (!isInnerBrainStoppable(record.status)) {
    return {
      ok: false,
      message: `实例 ${record.instanceId} 无法停止（状态：${record.status}）。仅 RUNNING/AWAITING/BLOCKED 可停止。`,
    };
  }

  const priorStatus = record.status;
  const actions: string[] = [];

  const brainDir = path.join(record.workDir, '.brain');
  const pendingsFile = path.join(brainDir, 'pendings.json');
  if (fs.existsSync(pendingsFile)) {
    for (const p of listActivePendings(brainDir)) {
      resolvePending(brainDir, p.id, {
        status: 'cancelled',
        result: { reason, cancelled_at: new Date().toISOString() },
      });
      actions.push(`cancelled:${p.id}`);
    }
    const unconsumed = listUnconsumedResolved(brainDir);
    if (unconsumed.length > 0) {
      markConsumed(brainDir, unconsumed.map((p) => p.id));
      actions.push(`consumed_resolved:${unconsumed.length}`);
    }
  }

  writeStopSignal(record.workDir);
  actions.push('stop_signal');

  if (record.pid != null && isPidAlive(record.pid)) {
    try {
      process.kill(record.pid, 'SIGTERM');
      actions.push(`sigterm:${record.pid}`);
    } catch {
      actions.push('sigterm_failed');
    }
  }

  registry.update(record.instanceId, {
    status: 'STOPPED',
    finishedAt: new Date().toISOString(),
    pid: undefined,
  });
  actions.push('registry=STOPPED');

  return { ok: true, priorStatus, actions };
}
