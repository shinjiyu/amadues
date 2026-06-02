/**
 * Framework benchmark — 场景结果类型
 * @see doc/structurizr/FRAMEWORK-BENCHMARK.md
 */

export interface ScenarioMetrics {
  llmCalls: number;
  estimatedPromptTokens: number;
  ticks: number;
  executorLlmCalls: number;
  maxExecutorRound: number;
  toolCalls: number;
  wallMs: number;
}

export interface ScenarioResult {
  scenarioId: string;
  passed: boolean;
  error?: string;
  metrics: ScenarioMetrics;
}

export interface FrameworkBenchmarkBaseline {
  version: number;
  scenarios: Record<string, ScenarioMetrics>;
}

export interface FrameworkBenchmarkReport {
  gitSha?: string;
  ranAt: string;
  scenarios: ScenarioResult[];
}
