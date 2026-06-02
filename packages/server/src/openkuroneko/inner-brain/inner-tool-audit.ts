/**
 * 内脑（DyFlow baseNode / Designer）工具调用审计 — JSONL 落盘。
 * 对齐外脑 outer-tool-audit（tool.call / tool.result）。
 *
 * 路径：DATA_ROOT/inner/tool-logs/<workspaceId>/YYYY-MM-DD.jsonl
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.4
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { redactToolArgs } from '../../outer/outer-tool-audit.js';

export interface InnerToolAuditEntry {
  schema: 'inner-tool-audit.v1';
  log_id: string;
  ts: string;
  workspace_id: string;
  module: 'base-node' | 'designer' | 'node-creator';
  event: 'tool.call' | 'tool.result';
  data: Record<string, unknown>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default';
}

function logsDir(dataRoot: string, workspaceId: string): string {
  return path.join(dataRoot, 'inner', 'tool-logs', safeWorkspaceId(workspaceId));
}

function appendJsonl(dataRoot: string, workspaceId: string, entry: InnerToolAuditEntry): void {
  const dir = logsDir(dataRoot, workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${today()}.jsonl`);
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf8');
}

/** 从 workDir（…/data-…/workspaces/task-ib-xxx）推导 DATA_ROOT 与 workspaceId */
export function resolveInnerToolAuditPaths(workDir: string): {
  dataRoot: string;
  workspaceId: string;
} {
  const workspaceId = path.basename(workDir);
  const parentName = path.basename(path.dirname(workDir));
  if (parentName === 'workspaces') {
    return { dataRoot: path.dirname(path.dirname(workDir)), workspaceId };
  }
  const envRoot = process.env['UTLRA_DATA_ROOT']?.trim();
  if (envRoot) return { dataRoot: envRoot, workspaceId };
  return { dataRoot: workDir, workspaceId };
}

export interface RecordInnerToolCallOpts {
  dataRoot: string;
  workspaceId: string;
  module: InnerToolAuditEntry['module'];
  nodeInstId?: string;
  burstId?: string;
  reactRound: number;
  toolName: string;
  args: Record<string, unknown>;
}

export function recordInnerToolCall(opts: RecordInnerToolCallOpts): void {
  const redacted = redactToolArgs(opts.toolName, opts.args);
  appendJsonl(opts.dataRoot, opts.workspaceId, {
    schema: 'inner-tool-audit.v1',
    log_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    workspace_id: opts.workspaceId,
    module: opts.module,
    event: 'tool.call',
    data: {
      round: opts.reactRound,
      name: opts.toolName,
      args: redacted,
      ...(opts.nodeInstId ? { node_inst_id: opts.nodeInstId } : {}),
      ...(opts.burstId ? { burst_id: opts.burstId } : {}),
    },
  });
}

export interface RecordInnerToolResultOpts {
  dataRoot: string;
  workspaceId: string;
  module: InnerToolAuditEntry['module'];
  nodeInstId?: string;
  burstId?: string;
  reactRound: number;
  toolName: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

export function recordInnerToolResult(opts: RecordInnerToolResultOpts): void {
  const preview = opts.output.trim().replace(/\s+/g, ' ').slice(0, 240);
  appendJsonl(opts.dataRoot, opts.workspaceId, {
    schema: 'inner-tool-audit.v1',
    log_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    workspace_id: opts.workspaceId,
    module: opts.module,
    event: 'tool.result',
    data: {
      round: opts.reactRound,
      name: opts.toolName,
      ok: opts.ok,
      duration_ms: opts.durationMs,
      preview,
      output_len: opts.output.length,
      ...(opts.nodeInstId ? { node_inst_id: opts.nodeInstId } : {}),
      ...(opts.burstId ? { burst_id: opts.burstId } : {}),
    },
  });
}
