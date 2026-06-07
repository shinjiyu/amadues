/**
 * KPI burst 过程报告组装 — ADL KPI-BURST-OUTCOME-EVALUATOR.md §2
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveInnerToolAuditPaths } from '../../openkuroneko/inner-brain/inner-tool-audit.js';
import type { FailureSummary, InnerMemory, NodeResult } from '../../openkuroneko/inner-brain/types.js';
import { pickDeliverableExcerpt } from '../../openkuroneko/burst/completion-report.js';

export interface BurstProcessReportInput {
  workDir: string;
  dataRoot?: string;
  workspaceId?: string;
  maxToolLines?: number;
  maxPiMonoLines?: number;
}

export interface BurstProcessReport {
  deliverablePaths: string[];
  deliverableCount: number;
  deliverableExcerpt: string | null;
  toolLogTail: string;
  nodeResultsSummary: string;
  lastFailure: string | null;
  piMonoLogTail: string;
  digest: string;
}

function readDeliverablePaths(workDir: string): string[] {
  const fp = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    if (!fs.existsSync(fp)) return [];
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function readMemoryJson(workDir: string): InnerMemory | null {
  const fp = path.join(workDir, '.brain', 'memory.json');
  try {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as InnerMemory;
  } catch {
    return null;
  }
}

function summarizeNodeResults(nodeResults: Record<string, NodeResult> | undefined): string {
  if (!nodeResults || Object.keys(nodeResults).length === 0) {
    return '（无 node_results）';
  }
  const lines: string[] = [];
  for (const [id, r] of Object.entries(nodeResults)) {
    const status = r.status ?? 'unknown';
    const summary = (r.summary ?? '').replace(/\s+/g, ' ').slice(0, 120);
    lines.push(`- ${id}: ${status}${summary ? ` — ${summary}` : ''}`);
  }
  return lines.join('\n');
}

function formatLastFailure(f: FailureSummary | null | undefined): string | null {
  if (!f) return null;
  const parts = [
    f.node_id ? `node=${f.node_id}` : '',
    f.message?.slice(0, 300) ?? '',
  ].filter(Boolean);
  return parts.join(' | ') || null;
}

function tailJsonlFiles(dir: string, maxLines: number): string {
  if (!fs.existsSync(dir)) return '（无工具审计日志）';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  if (files.length === 0) return '（无工具审计日志）';

  const lines: string[] = [];
  for (const file of files.slice(-2)) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const fileLines = raw.split('\n').filter(Boolean);
      for (const line of fileLines.slice(-maxLines)) {
        try {
          const entry = JSON.parse(line) as {
            event?: string;
            data?: { name?: string; ok?: boolean; preview?: string };
          };
          if (entry.event === 'tool.result') {
            const ok = entry.data?.ok ?? true;
            const name = entry.data?.name ?? '?';
            const preview = entry.data?.preview ?? '';
            lines.push(`${ok ? 'ok' : 'FAIL'} ${name}: ${preview}`);
          } else if (entry.event === 'tool.call') {
            lines.push(`call ${entry.data?.name ?? '?'}`);
          }
        } catch {
          lines.push(line.slice(0, 160));
        }
      }
    } catch {
      /* skip file */
    }
  }
  return lines.length > 0 ? lines.slice(-maxLines).join('\n') : '（工具日志为空）';
}

function tailPiMonoLogs(workDir: string, maxLines: number): string {
  const logDir = path.join(workDir, '.run', 'pi-mono', 'logs');
  if (!fs.existsSync(logDir)) return '（无 pi-mono 日志）';
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
  if (files.length === 0) return '（无 pi-mono 日志）';
  try {
    const raw = fs.readFileSync(path.join(logDir, files[files.length - 1]!), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-maxLines)
      .map((l) => l.slice(0, 200))
      .join('\n');
  } catch {
    return '（pi-mono 日志读取失败）';
  }
}

/** 从 workDir 组装过程报告（纯读盘，无 LLM） */
export function buildBurstProcessReport(input: BurstProcessReportInput): BurstProcessReport {
  const maxTool = input.maxToolLines ?? 40;
  const maxPi = input.maxPiMonoLines ?? 25;
  const deliverablePaths = readDeliverablePaths(input.workDir);
  const deliverableCount = deliverablePaths.length;
  const deliverableExcerpt = pickDeliverableExcerpt(input.workDir, deliverablePaths);

  const { dataRoot, workspaceId } = input.dataRoot && input.workspaceId
    ? { dataRoot: input.dataRoot, workspaceId: input.workspaceId }
    : resolveInnerToolAuditPaths(input.workDir);
  const toolLogDir = path.join(dataRoot, 'inner', 'tool-logs', workspaceId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128));

  const mem = readMemoryJson(input.workDir);
  const nodeResultsSummary = summarizeNodeResults(mem?.node_results);
  const lastFailure = formatLastFailure(mem?.last_failure ?? null);
  const toolLogTail = tailJsonlFiles(toolLogDir, maxTool);
  const piMonoLogTail = tailPiMonoLogs(input.workDir, maxPi);

  const digestParts = [
    `deliverables=${deliverableCount}`,
    deliverableExcerpt ? `excerpt:\n${deliverableExcerpt.slice(0, 1200)}` : '',
    lastFailure ? `last_failure: ${lastFailure}` : '',
    `node_results:\n${nodeResultsSummary}`,
    `tools:\n${toolLogTail.slice(0, 2000)}`,
    `pi_mono:\n${piMonoLogTail.slice(0, 1500)}`,
  ].filter(Boolean);

  return {
    deliverablePaths,
    deliverableCount,
    deliverableExcerpt,
    toolLogTail,
    nodeResultsSummary,
    lastFailure,
    piMonoLogTail,
    digest: digestParts.join('\n\n'),
  };
}
