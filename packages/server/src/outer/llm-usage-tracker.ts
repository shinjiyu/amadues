/**
 * LLM 调用计量 — in-flight 计数 + usage 滚动窗口（供 resourceProbe 使用）+ journal 落盘。
 */
import { appendLlmUsageJournalEntry } from './llm-usage-journal.js';
import type { LlmUsageRecordMeta, LlmUsageSource } from './llm-usage-types.js';
import { parseLlmUsageFromResponse } from './llm-usage-types.js';

const DEFAULT_WINDOW_MS = 86_400_000;

interface UsageSample {
  at: number;
  prompt: number;
  completion: number;
}

let inFlight = 0;
const samples: UsageSample[] = [];

let journalConfig: { dataRoot: string; agentId: string } | null = null;

function windowMs(): number {
  const raw = Number(process.env['UTLRA_LLM_USAGE_TRACK_WINDOW_MS'] ?? DEFAULT_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MS;
}

function prune(now = Date.now()): void {
  const cutoff = now - windowMs();
  while (samples.length > 0 && samples[0]!.at < cutoff) {
    samples.shift();
  }
}

export function configureLlmUsageTracker(cfg: { dataRoot: string; agentId: string }): void {
  journalConfig = { dataRoot: cfg.dataRoot, agentId: cfg.agentId };
}

function resolveJournalConfig(): { dataRoot: string; agentId: string } | null {
  if (journalConfig) return journalConfig;
  const dataRoot = process.env['UTLRA_DATA_ROOT']?.trim();
  if (!dataRoot) return null;
  const agentId =
    process.env['UTLRA_AGENT_NAME']?.trim() ||
    process.env['UTLRA_AGENT_IM_SID']?.trim() ||
    'unknown';
  return { dataRoot, agentId };
}

export function beginLlmCall(): void {
  inFlight += 1;
}

export function endLlmCall(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function recordLlmUsageFromResponse(
  raw: unknown,
  meta: Partial<LlmUsageRecordMeta> = {},
  opts: { ok?: boolean; durationMs?: number } = {},
): void {
  const parsed = parseLlmUsageFromResponse(raw);
  if (!parsed) return;

  prune();
  samples.push({
    at: Date.now(),
    prompt: parsed.promptTokens,
    completion: parsed.completionTokens,
  });

  const cfg = resolveJournalConfig();
  if (!cfg) return;

  const model =
    meta.model?.trim() ||
    (typeof (raw as { model?: unknown })?.model === 'string'
      ? (raw as { model: string }).model
      : 'unknown');

  const source: LlmUsageSource = meta.source ?? 'unknown';
  appendLlmUsageJournalEntry(cfg.dataRoot, {
    at: new Date().toISOString(),
    source,
    model,
    provider: meta.provider,
    agentId: meta.agentId ?? cfg.agentId,
    workspaceId: meta.workspaceId,
    instanceId: meta.instanceId,
    threadId: meta.threadId,
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    reasoningTokens: parsed.reasoningTokens,
    totalTokens: parsed.totalTokens,
    ok: opts.ok ?? true,
    durationMs: opts.durationMs,
  });
}

export function getLlmUsageSnapshot(now = Date.now()): {
  inFlight: number;
  tokensLast1h: { prompt: number; completion: number; total: number };
  callsLast1h: number;
} {
  prune(now);
  const hourCutoff = now - 3_600_000;
  let prompt = 0;
  let completion = 0;
  let callsLast1h = 0;
  for (const s of samples) {
    if (s.at >= hourCutoff) {
      prompt += s.prompt;
      completion += s.completion;
      callsLast1h += 1;
    }
  }
  return {
    inFlight,
    tokensLast1h: { prompt, completion, total: prompt + completion },
    callsLast1h,
  };
}

/** 测试用 */
export function resetLlmUsageTrackerForTests(): void {
  inFlight = 0;
  samples.length = 0;
  journalConfig = null;
}
