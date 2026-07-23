/**
 * 内脑任务完成 → IM 通知：工作区重建白话短结论（有附件不贴报告全文）。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ChatAssetStore, ChatIRChannel } from '@utlra/chat-ir';
import type { DeliverableAsset, InnerBrainEngine } from '../workspace-kit/index.js';

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

/** KPI 挂接 burst 不走 IM 完成通知（ADL KPI-BURST-OUTCOME-EVALUATOR §1） */
export function shouldNotifyUserOnBurstExit(record: { kpiId?: string }): boolean {
  return !record.kpiId?.trim();
}

/**
 * R4.7 / DELIVERABLE-PIPELINE-GAPS Gap A：产物吸收与 IM 解耦。
 * onExit(DONE) 与 ERROR+partial **必须**调用；不发送 postMessage。
 */
export function ingestInnerBrainDeliverablesOnExit(
  deps: Pick<CompletionNotifyDeps, 'assetStore' | 'getEngine'>,
  opts: { workspaceId: string; workDir: string },
): { assets: DeliverableAsset[]; deliverables: string[] } {
  const { deliverables } = buildCompletionMessageFromWorkspace(opts.workDir);
  const ingest = ingestDeliverables(opts.workDir, deliverables, deps.assetStore);
  try {
    deps.getEngine(opts.workspaceId).setDeliverables(ingest.assets);
  } catch (e) {
    console.error('[completion-notify] setDeliverables failed:', e);
  }
  return { assets: ingest.assets, deliverables };
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

/** DyFlow memory.json active 事实；fallback legacy knowledge.md */
function readWorkspaceFacts(workDir: string): string | null {
  const memoryPath = path.join(workDir, '.brain', 'memory.json');
  const raw = safeReadFile(memoryPath);
  if (raw) {
    try {
      const mem = JSON.parse(raw) as {
        fact_records?: Array<{ status?: string; content: string }>;
        facts?: string[];
      };
      const active = (mem.fact_records ?? []).filter((r) => r.status === 'active' || r.status == null);
      if (active.length > 0) {
        return active.map((r) => r.content).join('\n');
      }
      if (mem.facts?.length) {
        return mem.facts.join('\n');
      }
    } catch {
      /* fall through */
    }
  }
  return safeReadFile(path.join(workDir, '.brain', 'knowledge.md'));
}

function safeReadFile(fp: string): string | null {
  try {
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
}

/** 从 memory.json last_failure 组装完成报告评估块 */
function readCompletionAssessmentFromWorkDir(workDir: string): {
  verdict: string;
  hardFailures: string[];
  softFailures: string[];
  nextStrategy: string;
} | null {
  const raw = safeReadFile(path.join(workDir, '.brain', 'memory.json'));
  if (!raw) return null;
  try {
    const mem = JSON.parse(raw) as {
      last_failure?: {
        summary?: string;
        attempted?: string[];
        confidence?: string;
        transient?: boolean;
      } | null;
    };
    const lf = mem.last_failure;
    if (!lf?.summary?.trim()) return null;
    const attempted = (lf.attempted ?? []).filter((s) => s.trim());
    const isHigh = lf.confidence !== 'low';
    return {
      verdict: lf.transient ? 'partial' : isHigh ? 'failed' : 'partial',
      hardFailures: isHigh ? [lf.summary.trim(), ...attempted].slice(0, 5) : [],
      softFailures: isHigh ? [] : [lf.summary.trim(), ...attempted].slice(0, 5),
      nextStrategy: '',
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
  const audience = options?.audience ?? 'im';
  const knowledge = audience === 'verbose' ? readWorkspaceFacts(workDir) : null;
  const resultExcerpt = pickDeliverableExcerpt(workDir, deliverables);

  const rebuilt = buildCompletionReport(
    {
      goal,
      milestones: shortenMilestonesForReport(milestonesRaw),
      knowledge,
      lastExecLog: readExecutionLog(workDir),
      completionAssessment: readCompletionAssessmentFromWorkDir(workDir),
      deliverables,
      resultExcerpt,
      completeMessage: completeEv?.message ?? null,
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

/** ✅ 摘要 + 正文：去掉与标题重复的首段，不带调试 instanceId */
function formatCompletionImText(
  headerLine: string,
  message: string,
  fileNote: string,
  gap: string,
): string {
  const header = headerLine.trim();
  const summary = header.replace(/^✅\s*/, '').trim();
  const body = message.trim();
  const paras = body ? body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) : [];
  const first = paras[0] ?? '';
  const summaryStem = summary.replace(/…$/, '');
  const duplicate =
    first.length > 0 &&
    (first === summary ||
      first.startsWith(summaryStem) ||
      summaryStem.startsWith(first.slice(0, Math.min(40, first.length))));
  const rest = duplicate ? paras.slice(1).join('\n\n') : body;
  const chunks: string[] = [header];
  if (gap) chunks.push(gap);
  if (rest) chunks.push(rest);
  let text = chunks.join('\n\n');
  if (fileNote) text += `\n${fileNote}`;
  return text;
}

async function postCompletionIm(
  deps: CompletionNotifyDeps,
  opts: {
    instanceId: string;
    workspaceId: string;
    workDir: string;
    originThread: string;
    headerLine: string;
    gapSummary?: string;
    /** onExit 已调用 ingestInnerBrainDeliverablesOnExit 时置 true，避免重复吸收 */
    skipIngest?: boolean;
  },
): Promise<void> {
  const { message, deliverables } = buildCompletionMessageFromWorkspace(opts.workDir);
  let assets: DeliverableAsset[];
  if (opts.skipIngest) {
    assets = deps.getEngine(opts.workspaceId).readStatus()?.deliverables ?? [];
  } else {
    assets = ingestInnerBrainDeliverablesOnExit(deps, {
      workspaceId: opts.workspaceId,
      workDir: opts.workDir,
    }).assets;
  }

  const successCount = assets.length;
  const requested = deliverables.length;
  const fileNote =
    successCount > 0
      ? successCount === 1
        ? '（附件里有产出）'
        : `（附了 ${successCount} 个文件）`
      : requested > 0
        ? '（有登记产物但附件没带上）'
        : '';

  const gap = opts.gapSummary?.trim() ?? '';
  // 白话短结论：✅ 摘要 + 可选补充；不重复贴同一段正文，不带 instanceId
  const completionText = formatCompletionImText(opts.headerLine, message, fileNote, gap);

  const attachmentParts: AttachmentPart[] = assets.map((d) => ({
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

/** 向内脑任务发起人发送「任务完成」IM（含产物附件） */
export async function notifyInnerBrainTaskComplete(
  deps: CompletionNotifyDeps,
  opts: {
    instanceId: string;
    workspaceId: string;
    workDir: string;
    originThread: string;
    /** R4.7：onExit 已 ingest 时跳过二次吸收 */
    skipIngest?: boolean;
  },
): Promise<void> {
  const { message } = buildCompletionMessageFromWorkspace(opts.workDir);
  await postCompletionIm(deps, {
    ...opts,
    headerLine: `✅ ${pickImSummary(message)}`,
  });
}

/** goal 未完全达成（如部署 BLOCKED）但本地有产出 — ⚠️ 部分完成 + 附件 */
export async function notifyInnerBrainTaskPartial(
  deps: CompletionNotifyDeps,
  opts: {
    instanceId: string;
    workspaceId: string;
    workDir: string;
    originThread: string;
    gapSummary: string;
    skipIngest?: boolean;
  },
): Promise<void> {
  await postCompletionIm(deps, {
    ...opts,
    headerLine: '⚠️ 内脑任务部分完成（未完全达成目标）',
    gapSummary: opts.gapSummary,
  });
}

/** 内脑 DyFlow 失败 / ERROR 终态 — 短消息，不 dump seed facts */
export async function notifyInnerBrainTaskFailed(
  deps: Pick<CompletionNotifyDeps, 'imClient' | 'agentSid'>,
  opts: {
    instanceId: string;
    originThread: string;
    reason: string;
  },
): Promise<void> {
  const reason = opts.reason.trim() || '内脑未能完成任务';
  const text =
    `❌ 内脑任务失败（\`${opts.instanceId}\`）\n\n` +
    `${reason.slice(0, 600)}` +
    (reason.length > 600 ? '…' : '');
  await deps.imClient.postMessage(opts.originThread, {
    sender_sid: deps.agentSid,
    text,
    parse_mentions: true,
  });
  console.log(`[completion-notify] failure sent (${opts.instanceId}): ${reason.slice(0, 80)}`);
}
