import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry, LogLevel, Logger, LogEventPayload, CreateLoggerOptions } from './types.js';
import { LOG_ENTRY_SCHEMA_VERSION } from './types.js';

const DEFAULT_RETAIN_DAYS = 7;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function logFilePath(logsDir: string): string {
  return path.join(logsDir, `${today()}.jsonl`);
}

export function pruneOldLogs(logsDir: string, retainDays: number): void {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const dateStr = entry.name.slice(0, 10);
    const ts = Date.parse(dateStr);
    if (!isNaN(ts) && ts < cutoff) {
      try {
        fs.rmSync(path.join(logsDir, entry.name), { force: true });
      } catch { /* ignore */ }
    }
  }
}

function mergeTags(defaultTags: string[] | undefined, payloadTags: string[] | undefined): string[] | undefined {
  const a = defaultTags?.filter(Boolean) ?? [];
  const b = payloadTags?.filter(Boolean) ?? [];
  if (a.length === 0 && b.length === 0) return undefined;
  return [...new Set([...a, ...b])];
}

export function createLogger(agentId: string, tempDir: string, options?: CreateLoggerOptions): Logger {
  const retainDays = options?.retainDays ?? DEFAULT_RETAIN_DAYS;
  const defaultTags = options?.defaultTags;
  const logsDir = path.join(tempDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  pruneOldLogs(logsDir, retainDays);

  let lastPruneDate = today();
  function maybePrune(): void {
    const d = today();
    if (d !== lastPruneDate) {
      lastPruneDate = d;
      pruneOldLogs(logsDir, retainDays);
    }
  }

  function write(level: LogLevel, module: string, payload: LogEventPayload): void {
    maybePrune();
    const analyzed = payload.analyzed === true;
    const tags = mergeTags(defaultTags, payload.tags);

    const entry: LogEntry = {
      schema_version: LOG_ENTRY_SCHEMA_VERSION,
      log_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      level,
      module,
      agentId,
      event: payload.event,
      analyzed,
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(analyzed
        ? {
            analyzed_at:
              payload.analyzed_at && payload.analyzed_at.length > 0
                ? payload.analyzed_at
                : new Date().toISOString(),
          }
        : {}),
      ...(payload.data !== undefined ? { data: payload.data } : {}),
    };

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(logFilePath(logsDir), line, 'utf8');
  }

  return {
    debug: (mod, p) => write('debug', mod, p),
    info:  (mod, p) => write('info',  mod, p),
    warn:  (mod, p) => write('warn',  mod, p),
    error: (mod, p) => write('error', mod, p),
  };
}
