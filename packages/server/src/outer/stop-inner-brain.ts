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

const INSTANCE_ID_RE = /\bib-[a-z0-9]+-[a-f0-9]{4}\b/gi;

/** 用户明确要求终止内脑（比 belief-reconcile 更宽，含「停掉」「杀了」） */
const STOP_TASK_INTENT_RE =
  /停掉|停(?:止|了)|放弃|别做了|不用做了|取消(?:掉|了)?|杀了|kill|关掉|terminate/i;

const STOP_ALL_ON_THREAD_RE = /都停|全部停|全停|三个.*停|停(?:掉|止).*(?:都|全部)/i;

export interface InboundStopResult {
  stopped: string[];
  /** 工具/日志用摘要 */
  summaries: string[];
}

function awaitingOnThread(registry: InnerBrainRegistry, threadId: string): TaskRecord[] {
  return registry
    .list()
    .filter(
      (t) =>
        isInnerBrainStoppable(t.status) &&
        t.originThread === threadId,
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

/**
 * 人消息入站时优先识别「停任务」意图，直接 stop（避免只 resolve ask_user 反而唤醒内脑）。
 * 在 `resolveAwaitingInboundFromIm` 之前调用。
 */
export function tryStopInnerBrainsFromInbound(
  registry: InnerBrainRegistry,
  threadId: string,
  text: string,
): InboundStopResult {
  const t = text.trim();
  if (!t || !STOP_TASK_INTENT_RE.test(t)) {
    return { stopped: [], summaries: [] };
  }

  const stopped: string[] = [];
  const summaries: string[] = [];
  const seen = new Set<string>();

  const explicitIds = [...t.matchAll(INSTANCE_ID_RE)].map((m) => m[0]!.toLowerCase());
  for (const rawId of explicitIds) {
    const id = rawId;
    if (seen.has(id)) continue;
    const record = registry.get(id);
    if (!record) {
      summaries.push(`${id}:not_found`);
      continue;
    }
    if (!isInnerBrainStoppable(record.status)) {
      summaries.push(`${id}:already_${record.status}`);
      continue;
    }
    const res = stopInnerBrainInstance(record, registry, `inbound: ${t.slice(0, 120)}`);
    if (res.ok) {
      seen.add(id);
      stopped.push(id);
      summaries.push(`${id}:STOPPED(from_${res.priorStatus})`);
      console.log(
        `[utlra][stop-inner-brain] inbound ${id} prior=${res.priorStatus} actions=${res.actions.join(',')}`,
      );
    } else {
      summaries.push(`${id}:fail`);
    }
  }
  if (explicitIds.length > 0) {
    return { stopped, summaries };
  }

  const onThread = awaitingOnThread(registry, threadId);
  if (!onThread.length) {
    return { stopped, summaries };
  }

  const targets =
    STOP_ALL_ON_THREAD_RE.test(t) ? onThread : onThread.slice(0, 1);

  for (const record of targets) {
    if (seen.has(record.instanceId)) continue;
    const res = stopInnerBrainInstance(record, registry, `inbound: ${t.slice(0, 120)}`);
    if (res.ok) {
      seen.add(record.instanceId);
      stopped.push(record.instanceId);
      summaries.push(`${record.instanceId}:STOPPED(from_${res.priorStatus})`);
      console.log(
        `[utlra][stop-inner-brain] inbound ${record.instanceId} prior=${res.priorStatus} actions=${res.actions.join(',')}`,
      );
    }
  }

  return { stopped, summaries };
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
