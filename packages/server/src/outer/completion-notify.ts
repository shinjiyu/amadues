/**
 * 内脑任务完成 → IM 通知：从工作区磁盘重建「结果优先」的完成正文。
 * 避免只转发 milestones 过程描述或 output 里过时的薄报告。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ChatAssetStore, ChatIRChannel } from '@utlra/chat-ir';
import type { InnerBrainEngine } from '../workspace-kit/index.js';

import {
  buildCompletionReport,
  type CompletionReportAudience,
  pickDeliverableExcerpt,
  pickImSummary,
  shortenMilestonesForReport,
} from '../openkuroneko/burst/completion-report.js';
import { ingestDeliverables } from './deliverables-ingest.js';
import type { AttachmentPart } from './attach-expand.js';

export interface CompleteOutputEvent {
  type: 'COMPLETE';
  message: string;
  deliverables?: string[];
}

export interface CompletionNotifyDeps {
  imClient: ChatIRChannel;
  agentSid: string;
  assetStore: ChatAssetStore;
  getEngine: (workspaceId: string) => InnerBrainEngine;
}

/** 从 output 取最后一条 COMPLETE（忽略其后可能写入的 PROGRESS） */
export function readLastCompleteEvent(workDir: string): CompleteOutputEvent | null {
  const outputFile = path.join(workDir, '.run', 'pi-mono', 'output');
  if (!fs.existsSync(outputFile)) return null;

  const lines = fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        message?: string;
        deliverables?: unknown;
      };
      if (obj.type === 'COMPLETE' && typeof obj.message === 'string') {
        const deliverables = Array.isArray(obj.deliverables)
          ? obj.deliverables.filter((x): x is string => typeof x === 'string')
          : undefined;
        return { type: 'COMPLETE', message: obj.message, deliverables };
      }
    } catch {
      if (line.startsWith('[COMPLETE]')) {
        return { type: 'COMPLETE', message: line.replace('[COMPLETE]', '').trim() };
      }
    }
  }
  return null;
}

function safeReadFile(fp: string): string | null {
  try {
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
}

function readReflexionFromWorkDir(workDir: string): {
  verdict: string;
  hardFailures: string[];
  softFailures: string[];
  nextStrategy: string;
} | null {
  try {
    const raw = safeReadFile(path.join(workDir, '.brain', 'reflexion.json'));
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      verdict: String(obj['verdict'] ?? ''),
      hardFailures: Array.isArray(obj['hardFailures'])
        ? (obj['hardFailures'] as unknown[]).map(String)
        : [],
      softFailures: Array.isArray(obj['softFailures'])
        ? (obj['softFailures'] as unknown[]).map(String)
        : [],
      nextStrategy: String(obj['nextStrategy'] ?? ''),
    };
  } catch {
    return null;
  }
}

function readExecutionLog(workDir: string): import('../openkuroneko/brain/index.js').ExecutionEntry[] | null {
  try {
    const raw = safeReadFile(path.join(workDir, '.brain', 'execution-context.json'));
    if (!raw) return null;
    const ctx = JSON.parse(raw) as { executionLog?: unknown };
    return Array.isArray(ctx.executionLog)
      ? (ctx.executionLog as import('../openkuroneko/brain/index.js').ExecutionEntry[])
      : null;
  } catch {
    return null;
  }
}

function collectDeliverablePaths(workDir: string, fromEvent?: string[]): string[] {
  if (fromEvent && fromEvent.length > 0) return fromEvent;
  const fp = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    if (!fs.existsSync(fp)) return [];
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 通知时用最新磁盘状态重建完成报告（默认 `im`：结果优先；`verbose` 供外脑记忆） */
export function buildCompletionMessageFromWorkspace(
  workDir: string,
  options?: { audience?: CompletionReportAudience },
): {
  message: string;
  deliverables: string[];
} {
  const completeEv = readLastCompleteEvent(workDir);
  const deliverables = collectDeliverablePaths(workDir, completeEv?.deliverables);
  const goal = safeReadFile(path.join(workDir, '.brain', 'goal.md')) ?? '';
  const milestonesRaw = safeReadFile(path.join(workDir, '.brain', 'milestones.md')) ?? '';
  const knowledge = safeReadFile(path.join(workDir, '.brain', 'knowledge.md'));
  const resultExcerpt = pickDeliverableExcerpt(workDir, deliverables);

  const audience = options?.audience ?? 'im';
  const rebuilt = buildCompletionReport(
    {
      goal,
      milestones: shortenMilestonesForReport(milestonesRaw),
      knowledge,
      lastExecLog: readExecutionLog(workDir),
      reflexion: readReflexionFromWorkDir(workDir),
      deliverables,
      resultExcerpt,
    },
    { audience },
  );

  return { message: rebuilt, deliverables };
}

function completionNotifiedPath(workDir: string): string {
  return path.join(workDir, '.run', 'completion-notified.json');
}

function alreadyCompletionNotified(workDir: string, instanceId: string): boolean {
  const fp = completionNotifiedPath(workDir);
  if (!fs.existsSync(fp)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as { instanceId?: string };
    return raw.instanceId === instanceId;
  } catch {
    return false;
  }
}

function markCompletionNotified(
  workDir: string,
  instanceId: string,
  deliverableCount: number,
): void {
  const fp = completionNotifiedPath(workDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    JSON.stringify(
      { at: new Date().toISOString(), instanceId, deliverableCount },
      null,
      2,
    ),
    'utf8',
  );
}

/** 向内脑任务发起人发送「任务完成」IM（含产物附件） */
export async function notifyInnerBrainTaskComplete(
  deps: CompletionNotifyDeps,
  opts: {
    instanceId: string;
    workspaceId: string;
    workDir: string;
    originThread: string;
  },
): Promise<void> {
  const { message, deliverables } = buildCompletionMessageFromWorkspace(opts.workDir);
  const ingest = ingestDeliverables(opts.workDir, deliverables, deps.assetStore);

  try {
    deps.getEngine(opts.workspaceId).setDeliverables(ingest.assets);
  } catch (e) {
    console.error('[completion-notify] setDeliverables failed:', e);
  }

  const successCount = ingest.assets.length;
  const requested = deliverables.length;
  const summary = pickImSummary(message);
  const fileNote =
    successCount > 0
      ? `\n\n📎 已附上 ${successCount} 个产出文件，请直接查看附件。`
      : requested > 0
        ? `\n\n⚠️ 登记了 ${requested} 个产物但附件吸收失败（见 .run/deliverables.log）。`
        : '';

  const completionText = `✅ ${summary}\n\n${message.trim()}${fileNote}\n\n— \`${opts.instanceId}\``;

  const attachmentParts: AttachmentPart[] = ingest.assets.map((d) => ({
    type: 'attachment',
    asset_ref: {
      kind: d.kind,
      uri: `asset:${d.asset_id}`,
      mime: d.mime,
      name: d.filename,
    },
  }));

  if (alreadyCompletionNotified(opts.workDir, opts.instanceId)) {
    console.log(
      `[completion-notify] skip dedup (${opts.instanceId}): completion-notified.json exists`,
    );
    return;
  }

  const outboundBody =
    attachmentParts.length > 0
      ? {
          sender_sid: deps.agentSid,
          text: completionText,
          parts: [{ type: 'text' as const, text: completionText }, ...attachmentParts],
        }
      : { sender_sid: deps.agentSid, text: completionText };

  await deps.imClient.postMessage(opts.originThread, outboundBody);
  markCompletionNotified(opts.workDir, opts.instanceId, successCount);
  console.log(
    `[completion-notify] sent (${opts.instanceId}): deliverables ok=${successCount} requested=${requested}`,
  );
}
