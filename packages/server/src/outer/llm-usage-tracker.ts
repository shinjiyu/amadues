/**
 * LLM 调用计量 — in-flight 计数 + usage 滚动窗口（供 resourceProbe 使用）。
 */
const DEFAULT_WINDOW_MS = 86_400_000;

interface UsageSample {
  at: number;
  prompt: number;
  completion: number;
}

let inFlight = 0;
const samples: UsageSample[] = [];

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

export function beginLlmCall(): void {
  inFlight += 1;
}

export function endLlmCall(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function recordLlmUsageFromResponse(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const usage = (raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  if (!usage) return;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return;
  prune();
  samples.push({ at: Date.now(), prompt, completion });
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
}
