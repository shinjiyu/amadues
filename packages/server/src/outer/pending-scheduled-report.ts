/**
 * 日历 KPI 报告推送挂起队列：微信无 context_token 时先落盘，入站刷新 token 后冲刷。
 * ADL：KPI-BURST-OUTCOME-EVALUATOR §1 日历例外通知。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CompletionNotifyDeps } from './completion-notify.js';
import { notifyKpiScheduledReport } from './completion-notify.js';

const FILE = 'pending-scheduled-reports.json';

export interface PendingScheduledReport {
  instanceId: string;
  workspaceId?: string;
  workDir: string;
  originThread: string;
  kpiId?: string;
  workflowLabel: string;
  ok: boolean;
  detail?: string;
  enqueuedAt: string;
}

function filePath(dataRoot: string): string {
  return path.join(dataRoot, FILE);
}

function readAll(dataRoot: string): PendingScheduledReport[] {
  const p = filePath(dataRoot);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as PendingScheduledReport[]) : [];
  } catch {
    return [];
  }
}

function writeAll(dataRoot: string, rows: PendingScheduledReport[]): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(filePath(dataRoot), JSON.stringify(rows, null, 2), 'utf8');
}

export function enqueuePendingScheduledReport(
  dataRoot: string,
  row: Omit<PendingScheduledReport, 'enqueuedAt'> & { enqueuedAt?: string },
): void {
  const list = readAll(dataRoot).filter((r) => r.instanceId !== row.instanceId);
  list.push({
    ...row,
    enqueuedAt: row.enqueuedAt ?? new Date().toISOString(),
  });
  writeAll(dataRoot, list);
}

export function listPendingScheduledReports(dataRoot: string): PendingScheduledReport[] {
  return readAll(dataRoot);
}

/** 冲刷指定 thread 的挂起报告；成功则移除。 */
export async function flushPendingScheduledReportsForThread(
  dataRoot: string,
  threadId: string,
  deps: Pick<CompletionNotifyDeps, 'imClient' | 'agentSid'> &
    Partial<Pick<CompletionNotifyDeps, 'assetStore' | 'getEngine'>>,
): Promise<{ flushed: string[]; failed: string[] }> {
  const thread = threadId.trim();
  if (!thread) return { flushed: [], failed: [] };
  const list = readAll(dataRoot);
  const keep: PendingScheduledReport[] = [];
  const flushed: string[] = [];
  const failed: string[] = [];
  for (const row of list) {
    if (row.originThread !== thread) {
      keep.push(row);
      continue;
    }
    try {
      // 允许重发：清掉假「已通知」标记
      const notified = path.join(row.workDir, '.run', 'completion-notified.json');
      if (fs.existsSync(notified)) fs.unlinkSync(notified);
      await notifyKpiScheduledReport(deps, {
        instanceId: row.instanceId,
        workspaceId: row.workspaceId,
        workDir: row.workDir,
        originThread: row.originThread,
        kpiId: row.kpiId,
        workflowLabel: row.workflowLabel,
        ok: row.ok,
        detail: row.detail,
      });
      flushed.push(row.instanceId);
    } catch (e) {
      failed.push(row.instanceId);
      keep.push(row);
      console.warn(
        `[pending-scheduled-report] flush failed ${row.instanceId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  writeAll(dataRoot, keep);
  if (flushed.length > 0) {
    console.log(
      `[pending-scheduled-report] flushed ${flushed.length} for thread=${thread}: ${flushed.join(',')}`,
    );
  }
  return { flushed, failed };
}
