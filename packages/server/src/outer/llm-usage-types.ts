/** LLM 调用来源（用于 token 统计分桶） */
export type LlmUsageSource =
  | 'outer_conversation'
  | 'outer_heartbeat'
  | 'autonomy'
  | 'performance_goal'
  | 'inner_llm_step'
  | 'inner_pi_mono'
  | 'probe'
  | 'unknown';

export interface LlmUsageRecordMeta {
  source: LlmUsageSource;
  model?: string;
  provider?: string;
  agentId?: string;
  workspaceId?: string;
  instanceId?: string;
  threadId?: string;
}

export interface LlmUsageJournalEntry {
  at: string;
  source: LlmUsageSource;
  model: string;
  provider?: string;
  agentId: string;
  workspaceId?: string;
  instanceId?: string;
  threadId?: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  ok: boolean;
  durationMs?: number;
}

export interface LlmUsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface LlmUsageSummary {
  agentId: string;
  capturedAt: string;
  windowHours: number;
  totals: LlmUsageBucket;
  runtime: {
    inFlight: number;
    tokensLast1h: { prompt: number; completion: number; total: number };
    callsLast1h: number;
  };
  bySource: Record<string, LlmUsageBucket>;
  byModel: Record<string, LlmUsageBucket>;
  recent: LlmUsageJournalEntry[];
}

export interface ParsedLlmUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** 从 OpenAI-compatible usage 对象解析 token 数（含 reasoning_tokens） */
export function parseLlmUsageFromResponse(raw: unknown): ParsedLlmUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = (raw as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') return null;

  const prompt = num(usage['prompt_tokens']);
  const completion = num(usage['completion_tokens']);
  const totalRaw = num(usage['total_tokens']);
  const details = usage['completion_tokens_details'];
  let reasoning = 0;
  if (details && typeof details === 'object') {
    reasoning = num((details as Record<string, unknown>)['reasoning_tokens']);
  }
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;

  const p = Number.isFinite(prompt) ? prompt : 0;
  const c = Number.isFinite(completion) ? completion : 0;
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : p + c;
  return {
    promptTokens: p,
    completionTokens: c,
    reasoningTokens: reasoning,
    totalTokens: total,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function emptyUsageBucket(): LlmUsageBucket {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function addToUsageBucket(bucket: LlmUsageBucket, entry: LlmUsageJournalEntry): void {
  bucket.calls += 1;
  bucket.promptTokens += entry.promptTokens;
  bucket.completionTokens += entry.completionTokens;
  bucket.reasoningTokens += entry.reasoningTokens;
  bucket.totalTokens += entry.totalTokens;
}
