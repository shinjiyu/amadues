import fs from 'node:fs';
import path from 'node:path';

export interface RunMetrics {
  llmCalls: number;
  llmFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolCallsByModule: Record<string, number>;
  toolCallsByName: Record<string, number>;
  /** DyFlow：最终 FSM 模式与 DAG 轮数 */
  dyflowMode?: string;
  dagRounds?: number;
  /** single：节点终态 */
  singleStatus?: string;
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

export function collectRunMetrics(opts: { dataRoot: string; workspaceId: string; workDir: string }): RunMetrics {
  const m: RunMetrics = {
    llmCalls: 0,
    llmFailures: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    toolCallsByModule: {},
    toolCallsByName: {},
  };

  for (const e of readJsonl(path.join(opts.dataRoot, 'usage', 'llm-usage.jsonl'))) {
    m.llmCalls += 1;
    if (e['ok'] === false) m.llmFailures += 1;
    m.promptTokens += num(e['promptTokens']);
    m.completionTokens += num(e['completionTokens']);
    m.totalTokens += num(e['totalTokens']);
  }

  const auditDir = path.join(opts.dataRoot, 'inner', 'tool-logs', opts.workspaceId);
  const auditFiles = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter(f => f.endsWith('.jsonl')) : [];
  for (const f of auditFiles) {
    for (const e of readJsonl(path.join(auditDir, f))) {
      if (e['event'] !== 'tool.call') continue;
      m.toolCalls += 1;
      bump(m.toolCallsByModule, String(e['module'] ?? 'unknown'));
      const data = (e['data'] ?? {}) as Record<string, unknown>;
      bump(m.toolCallsByName, String(data['name'] ?? 'unknown'));
    }
  }

  const state = readJson<{ mode?: string }>(path.join(opts.workDir, '.brain', 'dyflow-state.json'));
  if (state?.mode) m.dyflowMode = state.mode;
  const mem = readJson<{ dag_history?: unknown[] }>(path.join(opts.workDir, '.brain', 'memory.json'));
  if (state && Array.isArray(mem?.dag_history)) m.dagRounds = mem.dag_history.length;

  const single = readJson<{ status?: string }>(path.join(opts.workDir, '.run', 'single-node-baseline.json'));
  if (single?.status) m.singleStatus = single.status;

  return m;
}
