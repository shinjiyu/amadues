import fs from 'node:fs';
import path from 'node:path';

import type { LlmUsageJournalEntry, LlmUsageSummary } from './llm-usage-types.js';
import {
  addToUsageBucket,
  emptyUsageBucket,
  type LlmUsageBucket,
} from './llm-usage-types.js';

const LOG_DIR = 'usage';
const LOG_FILE = 'llm-usage.jsonl';

export function llmUsageJournalPath(dataRoot: string): string {
  return path.join(dataRoot, LOG_DIR, LOG_FILE);
}

export function appendLlmUsageJournalEntry(dataRoot: string, entry: LlmUsageJournalEntry): void {
  const dir = path.join(dataRoot, LOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(llmUsageJournalPath(dataRoot), JSON.stringify(entry) + '\n', 'utf8');
}

export interface ReadLlmUsageJournalOptions {
  /** 只读此时间点之后的条目（ISO 或 ms） */
  sinceMs?: number;
  /** 最多返回条数（从文件尾部向前） */
  limit?: number;
}

export function readLlmUsageJournalEntries(
  dataRoot: string,
  opts: ReadLlmUsageJournalOptions = {},
): LlmUsageJournalEntry[] {
  const file = llmUsageJournalPath(dataRoot);
  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const sinceMs = opts.sinceMs ?? 0;
  const limit = opts.limit ?? Number.MAX_SAFE_INTEGER;

  const out: LlmUsageJournalEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]!) as LlmUsageJournalEntry;
      if (!entry.at) continue;
      const atMs = Date.parse(entry.at);
      if (Number.isFinite(atMs) && atMs >= sinceMs) {
        out.push(entry);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out.reverse();
}

export function buildLlmUsageSummary(
  dataRoot: string,
  agentId: string,
  windowHours: number,
  runtime: LlmUsageSummary['runtime'],
  recentLimit = 30,
): LlmUsageSummary {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24;
  const sinceMs = Date.now() - hours * 3_600_000;
  const entries = readLlmUsageJournalEntries(dataRoot, { sinceMs });

  const totals = emptyUsageBucket();
  const bySource: Record<string, LlmUsageBucket> = {};
  const byModel: Record<string, LlmUsageBucket> = {};

  for (const entry of entries) {
    addToUsageBucket(totals, entry);
    const sk = entry.source || 'unknown';
    if (!bySource[sk]) bySource[sk] = emptyUsageBucket();
    addToUsageBucket(bySource[sk]!, entry);
    const mk = entry.model || 'unknown';
    if (!byModel[mk]) byModel[mk] = emptyUsageBucket();
    addToUsageBucket(byModel[mk]!, entry);
  }

  const recent = readLlmUsageJournalEntries(dataRoot, { limit: recentLimit });

  return {
    agentId,
    capturedAt: new Date().toISOString(),
    windowHours: hours,
    totals,
    runtime,
    bySource,
    byModel,
    recent,
  };
}
