/**
 * 外脑工具调用审计 — JSONL 落盘 + 行为日志辅助。
 * 对齐内脑 Pi-mono logs（tool.call / tool.result），路径：
 *   DATA_ROOT/outer/tool-logs/<agentSid>/YYYY-MM-DD.jsonl
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { IActionLogStore } from '../heartbeat/types.js';
import { toolNameToOperationType, writeActionEvent } from '../heartbeat/agent-behavior-log.js';

export interface OuterToolAuditEntry {
  schema: 'outer-tool-audit.v1';
  log_id: string;
  ts: string;
  agent_sid: string;
  thread_id: string;
  event: 'tool.call' | 'tool.result';
  data: Record<string, unknown>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeAgentDir(agentSid: string): string {
  return agentSid.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default';
}

function logsDir(dataRoot: string, agentSid: string): string {
  return path.join(dataRoot, 'outer', 'tool-logs', safeAgentDir(agentSid));
}

function appendJsonl(dataRoot: string, agentSid: string, entry: OuterToolAuditEntry): void {
  const dir = logsDir(dataRoot, agentSid);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${today()}.jsonl`);
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf8');
}

/** 工具参数脱敏（长文本截断；memory block 与 keychain 不再隐藏 value） */
export function redactToolArgs(
  _toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (k === 'text' && typeof v === 'string' && v.length > 200) {
      out[k] = `${v.slice(0, 200)}…[len=${v.length}]`;
      continue;
    }
    if (typeof v === 'string' && v.length > 500) {
      out[k] = `${v.slice(0, 500)}…[len=${v.length}]`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function isToolOutputOk(output: string): boolean {
  const t = output.trim();
  if (!t) return false;
  if (t.startsWith('（错误') || t.startsWith('（Memory Block 未启用') || t.startsWith('（block_id')) {
    return false;
  }
  if (t.startsWith('（body/value 为空') || t.startsWith('（未知工具')) return false;
  if (t.includes('verify failed')) return false;
  return true;
}

export interface RecordOuterToolCallOpts {
  dataRoot: string;
  agentSid: string;
  threadId: string;
  round: number;
  toolName: string;
  argsJson: string;
  actionLogStore?: IActionLogStore;
}

export function recordOuterToolCall(opts: RecordOuterToolCallOpts): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(opts.argsJson) as Record<string, unknown>;
  } catch {
    args = { _parseError: true, raw: opts.argsJson.slice(0, 200) };
  }
  const redacted = redactToolArgs(opts.toolName, args);

  appendJsonl(opts.dataRoot, opts.agentSid, {
    schema: 'outer-tool-audit.v1',
    log_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent_sid: opts.agentSid,
    thread_id: opts.threadId,
    event: 'tool.call',
    data: { round: opts.round, name: opts.toolName, args: redacted },
  });

  return redacted;
}

export interface RecordOuterToolResultOpts {
  dataRoot: string;
  agentSid: string;
  threadId: string;
  round: number;
  toolName: string;
  output: string;
  ok: boolean;
  durationMs: number;
  actionLogStore?: IActionLogStore;
}

export function recordOuterToolResult(opts: RecordOuterToolResultOpts): void {
  const preview = opts.output.trim().replace(/\s+/g, ' ').slice(0, 240);

  appendJsonl(opts.dataRoot, opts.agentSid, {
    schema: 'outer-tool-audit.v1',
    log_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent_sid: opts.agentSid,
    thread_id: opts.threadId,
    event: 'tool.result',
    data: {
      round: opts.round,
      name: opts.toolName,
      ok: opts.ok,
      duration_ms: opts.durationMs,
      preview,
    },
  });

  if (opts.actionLogStore) {
    const scope = `thread:${opts.threadId} tool:${opts.toolName} ok:${opts.ok}`;
    void writeActionEvent(
      opts.actionLogStore,
      opts.agentSid,
      toolNameToOperationType(opts.toolName),
      scope,
    ).catch((err) => {
      console.error('[utlra][outer-tool-audit] writeActionEvent failed', err);
    });
  }
}
