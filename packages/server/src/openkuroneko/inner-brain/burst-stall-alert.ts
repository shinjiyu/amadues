/**
 * 内脑空转告警落盘 + 索引。
 *
 * ADL：doc/structurizr/INNER-BURST-STALL-ALERT.md §3
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Logger } from '../logger/index.js';
import { resolveInnerToolAuditPaths } from './inner-tool-audit.js';
import {
  evaluateBurstStall,
  isBurstStallAlertEnabled,
  type BurstStallVerdict,
} from './burst-stall-evaluator.js';
import type { DyflowState, InnerMemory } from './types.js';
import type { MemoryStore } from './memory-store.js';
import { tailFileLines } from '../../pi-mono/tail-file.js';

export const STALL_ALERT_SCHEMA = 'burst-stall-alert.v1' as const;

export interface StallAlertIndexEntry {
  schema: typeof STALL_ALERT_SCHEMA;
  alertId: string;
  ts: string;
  instanceId: string;
  workspaceId: string;
  severity: 'warn' | 'critical';
  signals: string[];
  summary: string;
  bundlePath: string;
  bundlePathRepoRelative?: string;
}

export interface BurstStallAlertBundle {
  schema: typeof STALL_ALERT_SCHEMA;
  alertId: string;
  ts: string;
  instanceId: string;
  workspaceId: string;
  workDir: string;
  dataRoot: string;
  trigger: string;
  verdict: BurstStallVerdict;
  dyflow: DyflowState | null;
  memory: InnerMemory;
  deliverables: { count: number; paths: string[]; preview: unknown };
  tails: {
    piMonoLogFile: string | null;
    piMonoLogLines: string[];
    toolAuditFile: string | null;
    toolAuditLines: string[];
  };
  paths: {
    memoryJson: string;
    dyflowStateJson: string;
    piMonoLogsDir: string;
    toolAuditDir: string;
    stallAlertsDir: string;
  };
  cursor: {
    snippet: string;
    paths: string[];
  };
  registry?: Record<string, unknown>;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function debounceMs(): number {
  return readPositiveIntEnv('INNER_BURST_STALL_DEBOUNCE_MS', 120_000);
}

function stallAlertsRoot(dataRoot: string): string {
  return path.join(dataRoot, 'stall-alerts');
}

function safeInstanceId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

function isoFileStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'packages', 'server'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function toRepoRelative(absPath: string, repoRoot: string | null): string {
  if (!repoRoot) return absPath;
  const rel = path.relative(repoRoot, absPath);
  if (rel.startsWith('..')) return absPath;
  return rel.split(path.sep).join('/');
}

function readJsonFile<T>(fp: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as T;
  } catch {
    return null;
  }
}

function tailJsonlFile(fp: string | null, maxLines: number): { file: string | null; lines: string[] } {
  if (!fp || !fs.existsSync(fp)) return { file: fp, lines: [] };
  return { file: fp, lines: tailFileLines(fp, maxLines) };
}

function resolveLatestJsonl(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const today = new Date().toISOString().slice(0, 10);
  const todayPath = path.join(dir, `${today}.jsonl`);
  if (fs.existsSync(todayPath)) return todayPath;
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse();
  return files[0] ? path.join(dir, files[0]!) : null;
}

function tryRegistryStartedAtMs(dataRoot: string, instanceId: string): number | null {
  const fp = path.join(dataRoot, 'inner-brain-registry.json');
  try {
    const rows = JSON.parse(fs.readFileSync(fp, 'utf8')) as Array<{ instanceId?: string; startedAt?: string }>;
    if (!Array.isArray(rows)) return null;
    const row = rows.find(r => r.instanceId === instanceId);
    if (!row?.startedAt) return null;
    const t = new Date(row.startedAt).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function readDeliverables(workDir: string): { count: number; paths: string[]; preview: unknown } {
  const fp = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as {
      deliverables?: Array<{ relative_path?: string; path?: string }>;
    };
    const list = raw.deliverables ?? [];
    const paths = list
      .map(d => d.relative_path ?? d.path ?? '')
      .filter(Boolean) as string[];
    return { count: paths.length, paths, preview: raw };
  } catch {
    return { count: 0, paths: [], preview: null };
  }
}

function debounceStatePath(workDir: string): string {
  return path.join(workDir, '.brain', 'stall-alert-debounce.json');
}

function shouldDebounce(workDir: string, signalsKey: string): boolean {
  const fp = debounceStatePath(workDir);
  const prev = readJsonFile<{ at: string; signalsKey: string }>(fp);
  if (!prev) return false;
  if (prev.signalsKey !== signalsKey) return false;
  const elapsed = Date.now() - new Date(prev.at).getTime();
  return elapsed < debounceMs();
}

function writeDebounce(workDir: string, signalsKey: string, alertId: string): void {
  const fp = debounceStatePath(workDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    JSON.stringify({ at: new Date().toISOString(), signalsKey, alertId }, null, 2),
    'utf8',
  );
}

export interface MaybeEmitBurstStallAlertOpts {
  workDir: string;
  instanceId: string;
  trigger: string;
  memory: MemoryStore;
  logger: Logger;
  dyflowStatePath?: string;
  registryEntry?: Record<string, unknown>;
  startedAtMs?: number | null;
}

export function maybeEmitBurstStallAlert(opts: MaybeEmitBurstStallAlertOpts): StallAlertIndexEntry | null {
  if (!isBurstStallAlertEnabled()) return null;

  const { dataRoot, workspaceId } = resolveInnerToolAuditPaths(opts.workDir);
  const mem = opts.memory.read();
  const deliverables = readDeliverables(opts.workDir);
  const startedAtMs =
    opts.startedAtMs ?? tryRegistryStartedAtMs(dataRoot, opts.instanceId);
  const verdict = evaluateBurstStall({
    memory: mem,
    deliverableCount: deliverables.count,
    startedAtMs,
  });

  if (!verdict.stalled) return null;

  const signalsKey = verdict.signals.slice().sort().join('|');
  if (shouldDebounce(opts.workDir, signalsKey)) return null;

  const alertId = crypto.randomUUID().slice(0, 12);
  const ts = new Date().toISOString();
  const instanceId = opts.instanceId;
  const dyflowPath = opts.dyflowStatePath ?? path.join(opts.workDir, '.brain', 'dyflow-state.json');
  const dyflow = readJsonFile<DyflowState>(dyflowPath);

  const piMonoLogsDir = path.join(opts.workDir, '.run', 'pi-mono', 'logs');
  const safeWs = workspaceId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default';
  const toolAuditDir = path.join(dataRoot, 'inner', 'tool-logs', safeWs);
  const piMonoFile = resolveLatestJsonl(piMonoLogsDir);
  const toolAuditFile = resolveLatestJsonl(toolAuditDir);
  const piTail = tailJsonlFile(piMonoFile, 120);
  const toolTail = tailJsonlFile(toolAuditFile, 150);

  const repoRoot = findRepoRoot(opts.workDir);
  const bundleDir = path.join(stallAlertsRoot(dataRoot), safeInstanceId(instanceId));
  const bundleFileName = `${isoFileStamp(ts)}_${alertId}.json`;
  const bundlePath = path.join(bundleDir, bundleFileName);

  const pathsBlock = {
    memoryJson: path.join(opts.workDir, '.brain', 'memory.json'),
    dyflowStateJson: dyflowPath,
    piMonoLogsDir,
    toolAuditDir,
    stallAlertsDir: stallAlertsRoot(dataRoot),
  };

  const cursorPaths = [
    pathsBlock.memoryJson,
    pathsBlock.dyflowStateJson,
    piMonoFile,
    toolAuditFile,
    bundlePath,
  ]
    .filter((p): p is string => Boolean(p))
    .map(p => toRepoRelative(p, repoRoot));

  const bundle: BurstStallAlertBundle = {
    schema: STALL_ALERT_SCHEMA,
    alertId,
    ts,
    instanceId,
    workspaceId,
    workDir: opts.workDir,
    dataRoot,
    trigger: opts.trigger,
    verdict,
    dyflow,
    memory: mem,
    deliverables,
    tails: {
      piMonoLogFile: piTail.file,
      piMonoLogLines: piTail.lines,
      toolAuditFile: toolTail.file,
      toolAuditLines: toolTail.lines,
    },
    paths: pathsBlock,
    cursor: {
      snippet: [
        `内脑空转告警 ${alertId} · ${instanceId} · ${verdict.severity}`,
        verdict.summary,
        `触发: ${opts.trigger}`,
        `信号: ${verdict.signals.join(', ')}`,
        '',
        'Cursor 优先打开:',
        ...cursorPaths.map(p => `- ${p}`),
        '',
        `完整包: ${toRepoRelative(bundlePath, repoRoot)}`,
      ].join('\n'),
      paths: cursorPaths,
    },
    ...(opts.registryEntry ? { registry: opts.registryEntry } : {}),
  };

  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');

  const indexEntry: StallAlertIndexEntry = {
    schema: STALL_ALERT_SCHEMA,
    alertId,
    ts,
    instanceId,
    workspaceId,
    severity: verdict.severity,
    signals: verdict.signals,
    summary: verdict.summary,
    bundlePath,
    bundlePathRepoRelative: toRepoRelative(bundlePath, repoRoot),
  };

  const indexPath = path.join(stallAlertsRoot(dataRoot), 'index.jsonl');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.appendFileSync(indexPath, JSON.stringify(indexEntry) + '\n', 'utf8');

  writeDebounce(opts.workDir, signalsKey, alertId);

  opts.logger.warn('dyflow-controller', {
    event: 'stall.alert',
    data: {
      alertId,
      instanceId,
      workspaceId,
      severity: verdict.severity,
      signals: verdict.signals,
      bundlePath: indexEntry.bundlePathRepoRelative ?? bundlePath,
    },
  });

  return indexEntry;
}

export function listStallAlertIndex(dataRoot: string, limit: number): StallAlertIndexEntry[] {
  const indexPath = path.join(stallAlertsRoot(dataRoot), 'index.jsonl');
  if (!fs.existsSync(indexPath)) return [];
  const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  const sliced = lines.slice(-limit);
  const out: StallAlertIndexEntry[] = [];
  for (const line of sliced) {
    try {
      out.push(JSON.parse(line) as StallAlertIndexEntry);
    } catch {
      /* skip */
    }
  }
  return out.reverse();
}

export function readStallAlertBundle(dataRoot: string, alertId: string): BurstStallAlertBundle | null {
  const root = stallAlertsRoot(dataRoot);
  if (!fs.existsSync(root)) return null;
  for (const instDir of fs.readdirSync(root)) {
    const dir = path.join(root, instDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.includes(alertId)) continue;
      const full = path.join(dir, f);
      return readJsonFile<BurstStallAlertBundle>(full);
    }
  }
  return null;
}
