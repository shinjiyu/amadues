/**
 * 统一日志时间线 — 合并 IM 消息、外脑 tool 审计、内脑 Pi-mono、autonomy、trace。
 */
import fs from 'node:fs';
import path from 'node:path';

import { MessageRecordSchema, serializeMessageForLlm, type IdentityRegistry } from '@utlra/chat-ir';
import type { InnerBrainRegistry, TaskRecord } from '../outer/inner-brain-registry.js';
import { resolveAgentSid } from '../outer/outer-tools.js';
import { resolveAgentTimezone } from '../agent-time.js';

export type LogLane = 'chat' | 'outer' | 'inner' | 'autonomy' | 'trace' | 'directive';

export interface TimelineEntry {
  ts: string;
  lane: LogLane;
  kind: string;
  title: string;
  subtitle?: string;
  round?: number;
  ok?: boolean;
  detail?: unknown;
  raw?: Record<string, unknown>;
}

export interface LogSessionSummary {
  key: string;
  threadId: string;
  instanceId?: string;
  workspaceId?: string;
  startedAt: string;
  endedAt?: string;
  status?: string;
  goalPreview?: string;
  label: string;
}

function safeAgentDir(agentSid: string): string {
  return agentSid.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default';
}

function parseJsonlFile(fp: string, limit: number): Record<string, unknown>[] {
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean);
  const slice = lines.slice(-limit);
  const out: Record<string, unknown>[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      out.push({ _parseError: true, _raw: line.slice(0, 200) });
    }
  }
  return out;
}

function readOuterToolAudit(
  dataRoot: string,
  agentSid: string,
  opts: { threadId?: string; days?: number; limit?: number },
): Record<string, unknown>[] {
  const dir = path.join(dataRoot, 'outer', 'tool-logs', safeAgentDir(agentSid));
  if (!fs.existsSync(dir)) return [];
  const days = opts.days ?? 7;
  const limit = opts.limit ?? 2000;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .slice(-days);
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    out.push(...parseJsonlFile(path.join(dir, f), limit));
    if (out.length >= limit) break;
  }
  const filtered = opts.threadId
    ? out.filter((e) => String(e['thread_id'] ?? '') === opts.threadId)
    : out;
  return filtered.slice(-limit);
}

function readAutonomyLog(dataRoot: string, limit = 500): Record<string, unknown>[] {
  const fp = path.join(dataRoot, 'autonomy', 'action-log.jsonl');
  return parseJsonlFile(fp, limit);
}

function readWorkspaceJsonl(workDir: string, rel: string, limit: number): Record<string, unknown>[] {
  return parseJsonlFile(path.join(workDir, rel), limit);
}

function tsMs(ts: unknown): number {
  const n = Date.parse(String(ts ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function outerEntryTitle(event: string, data: Record<string, unknown>): string {
  const name = String(data['name'] ?? '?');
  if (event === 'tool.call') {
    const round = data['round'];
    return `外脑 R${round} · 调用 ${name}`;
  }
  if (event === 'tool.result') {
    const ok = data['ok'] === true;
    return `外脑 R${data['round']} · ${name} ${ok ? '成功' : '失败'}`;
  }
  return `外脑 · ${event}`;
}

function innerEntryTitle(mod: string, event: string, data: Record<string, unknown>): string {
  if (mod === 'executor' && event === 'llm.call') return `内脑 LLM 轮次 ${data['round'] ?? '?'}`;
  if (mod === 'executor' && event === 'tool.call') return `内脑工具 ${data['name']}`;
  if (mod === 'executor' && event === 'tool.result') {
    return `内脑 ${data['name']} ${data['ok'] === true ? '✓' : '✗'}`;
  }
  if (mod === 'decomposer') return `Decomposer · ${event}`;
  if (mod === 'controller') return `Controller · ${event}`;
  if (mod === 'attributor') return `Attributor · ${event}`;
  return `${mod} · ${event}`;
}

export function listLogSessions(
  dataRoot: string,
  registry: InnerBrainRegistry,
  agentSid?: string,
  limit = 40,
): LogSessionSummary[] {
  const sid = agentSid ?? resolveAgentSid();
  const tasks = registry.list().sort((a, b) => tsMs(b.startedAt) - tsMs(a.startedAt));
  const sessions: LogSessionSummary[] = [];

  for (const t of tasks.slice(0, limit)) {
    sessions.push({
      key: t.instanceId,
      threadId: t.originThread ?? '',
      instanceId: t.instanceId,
      workspaceId: t.workspaceId,
      startedAt: t.startedAt,
      endedAt: t.finishedAt,
      status: t.status,
      goalPreview: t.goal.slice(0, 120),
      label: `[${t.status}] ${t.instanceId} — ${t.goal.slice(0, 60)}…`,
    });
  }

  const audit = readOuterToolAudit(dataRoot, sid, { days: 3, limit: 500 });
  const byThread = new Map<string, string>();
  for (const row of audit) {
    const tid = String(row['thread_id'] ?? '');
    const ts = String(row['ts'] ?? '');
    if (!tid || byThread.has(tid)) continue;
    byThread.set(tid, ts);
  }
  for (const [threadId, startedAt] of byThread) {
    if (sessions.some((s) => s.threadId === threadId && !s.instanceId)) continue;
    sessions.push({
      key: `thread:${threadId}`,
      threadId,
      startedAt,
      label: `线程 ${threadId}`,
    });
  }

  sessions.sort((a, b) => tsMs(b.startedAt) - tsMs(a.startedAt));
  return sessions.slice(0, limit);
}

export function buildLogTimeline(opts: {
  dataRoot: string;
  registry: InnerBrainRegistry;
  registryIdentity: IdentityRegistry;
  loadThreads: () => { messages: Record<string, unknown[]> };
  threadId?: string;
  instanceId?: string;
  limit?: number;
  agentSid?: string;
}): { entries: TimelineEntry[]; meta: Record<string, unknown> } {
  const limit = Math.min(2000, Math.max(50, opts.limit ?? 800));
  const agentSid = opts.agentSid ?? resolveAgentSid();
  const entries: TimelineEntry[] = [];
  let task: TaskRecord | undefined;
  let workDir: string | undefined;

  if (opts.instanceId) {
    task = opts.registry.get(opts.instanceId);
    workDir = task?.workDir;
  }

  const threadId = opts.threadId?.trim() || task?.originThread?.trim() || '';

  if (threadId) {
    try {
      const raw = opts.loadThreads().messages[threadId] ?? [];
      const tz = resolveAgentTimezone();
      for (const m of raw.slice(-200)) {
        const parsed = MessageRecordSchema.safeParse(m);
        if (!parsed.success) continue;
        const msg = parsed.data;
        const sender = opts.registryIdentity.get(msg.sender_sid);
        const body = serializeMessageForLlm(
          msg,
          sender?.display_name ?? msg.sender_sid,
          sender?.kind ?? 'human',
          tz,
        );
        entries.push({
          ts: msg.sent_at,
          lane: 'chat',
          kind: sender?.kind === 'agent' ? 'agent.message' : 'human.message',
          title: sender?.kind === 'agent' ? `Agent 发言` : `用户发言`,
          subtitle: body.split('\n').slice(1).join('\n').slice(0, 400) || body.slice(0, 400),
          raw: msg as unknown as Record<string, unknown>,
        });
      }
    } catch {
      /* ignore */
    }

    const audit = readOuterToolAudit(opts.dataRoot, agentSid, { threadId, days: 14, limit });
    for (const row of audit) {
      const event = String(row['event'] ?? '');
      const data = (row['data'] as Record<string, unknown>) ?? {};
      entries.push({
        ts: String(row['ts'] ?? ''),
        lane: 'outer',
        kind: event,
        title: outerEntryTitle(event, data),
        round: typeof data['round'] === 'number' ? data['round'] : undefined,
        ok: data['ok'] === true ? true : data['ok'] === false ? false : undefined,
        subtitle: String(data['preview'] ?? JSON.stringify(data['args'] ?? '')).slice(0, 500),
        detail: data,
        raw: row,
      });
    }
  }

  if (workDir && fs.existsSync(workDir)) {
    const logsDir = path.join(workDir, '.run', 'pi-mono', 'logs');
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.jsonl')).sort();
      for (const f of files.slice(-3)) {
        for (const row of parseJsonlFile(path.join(logsDir, f), limit)) {
          const mod = String(row['module'] ?? '');
          const event = String(row['event'] ?? '');
          const data = (row['data'] as Record<string, unknown>) ?? {};
          entries.push({
            ts: String(row['ts'] ?? ''),
            lane: 'inner',
            kind: `${mod}.${event}`,
            title: innerEntryTitle(mod, event, data),
            round: typeof data['round'] === 'number' ? data['round'] : undefined,
            ok: data['ok'] === true ? true : data['ok'] === false ? false : undefined,
            subtitle: String(data['preview'] ?? data['reason'] ?? '').slice(0, 400),
            detail: data,
            raw: row,
          });
        }
      }
    }

    for (const row of readWorkspaceJsonl(workDir, '.run/telemetry/trace.jsonl', 200)) {
      entries.push({
        ts: String(row['ts'] ?? ''),
        lane: 'trace',
        kind: String(row['event'] ?? 'trace'),
        title: `Trace · ${String(row['event'] ?? 'event')}`,
        subtitle: JSON.stringify(row).slice(0, 200),
        raw: row,
      });
    }

    for (const row of readWorkspaceJsonl(workDir, '.run/directives.jsonl', 100)) {
      entries.push({
        ts: String(row['ts'] ?? row['at'] ?? ''),
        lane: 'directive',
        kind: 'directive',
        title: 'Directive 注入',
        subtitle: String(row['text'] ?? row['feedback'] ?? JSON.stringify(row)).slice(0, 300),
        raw: row,
      });
    }
  }

  for (const row of readAutonomyLog(opts.dataRoot, 300)) {
    entries.push({
      ts: String(row['at'] ?? ''),
      lane: 'autonomy',
      kind: String(row['reason'] ?? 'autonomy'),
      title: row['dispatched'] === true
        ? `Autonomy 派发 · ${String(row['taskType'] ?? '')}`
        : `Autonomy 跳过 · ${String(row['reason'] ?? '')}`,
      subtitle: String(row['detail'] ?? '').slice(0, 200),
      raw: row,
    });
  }

  entries.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  const trimmed = entries.slice(-limit);

  const outerRounds = new Set(
    trimmed.filter((e) => e.lane === 'outer' && e.round != null).map((e) => e.round),
  );

  return {
    entries: trimmed,
    meta: {
      threadId: threadId || null,
      instanceId: opts.instanceId ?? null,
      workspaceId: task?.workspaceId ?? null,
      goal: task?.goal?.slice(0, 500) ?? null,
      status: task?.status ?? null,
      outerRoundNumbers: [...outerRounds].sort((a, b) => (a ?? 0) - (b ?? 0)),
      counts: {
        chat: trimmed.filter((e) => e.lane === 'chat').length,
        outer: trimmed.filter((e) => e.lane === 'outer').length,
        inner: trimmed.filter((e) => e.lane === 'inner').length,
        autonomy: trimmed.filter((e) => e.lane === 'autonomy').length,
        trace: trimmed.filter((e) => e.lane === 'trace').length,
        directive: trimmed.filter((e) => e.lane === 'directive').length,
      },
    },
  };
}
