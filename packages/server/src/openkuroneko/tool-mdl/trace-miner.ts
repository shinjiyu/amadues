/**
 * traceMiner — 候选生成（ADL: TOOL-MDL-GROWTH.md M4 / M8）
 *
 * 「何时该造工具」不是判断题，是压缩题：候选来自动作日志上的频繁子序列挖掘，
 * 模型不参与这一步。范型见 SEQUITUR（Nevill-Manning & Witten 1997）与 BPE。
 *
 * M8：挖掘前**必须**先用当前库重编码，否则层级深度恒为 1，工具永不调用工具。
 */

export interface MinableRecord {
  runId: string;
  step: number;
  symbol: string;
  args: Record<string, unknown>;
}

export interface CandidateInstance {
  runId: string;
  startStep: number;
}

export interface ToolCandidate {
  symbols: string[];
  support: number;
  gain: number;
  instances: CandidateInstance[];
}

export interface MineOptions {
  minSupport: number;
  /** 最小压缩增益。只设 minSupport 会挖出 `cd; ls` 这类零价值平凡对 */
  minGain: number;
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 8;

function groupByRun<T extends { runId: string }>(records: T[]): T[][] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const r of records) {
    if (!buckets.has(r.runId)) {
      buckets.set(r.runId, []);
      order.push(r.runId);
    }
    buckets.get(r.runId)!.push(r);
  }
  return order.map(id => buckets.get(id)!);
}

/** 压缩增益：把 n 次出现的长 len 片段折成一个符号所省下的符号数 */
function gainOf(support: number, length: number): number {
  return (support - 1) * length;
}

export function mineCandidates(records: MinableRecord[], opts: MineOptions): ToolCandidate[] {
  const maxLen = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  const found = new Map<string, { symbols: string[]; instances: CandidateInstance[] }>();

  // 只在单个 run 内滑窗——跨 run 边界的相邻不是复发
  for (const run of groupByRun(records)) {
    for (let len = 2; len <= maxLen; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const window = run.slice(i, i + len);
        const symbols = window.map(r => r.symbol);
        const key = symbols.join('\u0000');
        if (!found.has(key)) found.set(key, { symbols, instances: [] });
        found.get(key)!.instances.push({ runId: run[0].runId, startStep: window[0].step });
      }
    }
  }

  const out: ToolCandidate[] = [];
  for (const { symbols, instances } of found.values()) {
    const support = instances.length;
    if (support < opts.minSupport) continue;
    const gain = gainOf(support, symbols.length);
    if (gain < opts.minGain) continue;
    out.push({ symbols, support, gain, instances });
  }

  // BPE 贪心序：增益大的先合并
  out.sort((a, b) => b.gain - a.gain || b.support - a.support || a.symbols.length - b.symbols.length);
  return out;
}

export interface LibraryRule {
  name: string;
  symbols: string[];
}

/**
 * 用当前工具库重写日志：命中的片段折成单个符号（非终结符）。
 * 同一位置取**最长匹配**。步号重新编号，args 合并。
 */
export function reEncode<T extends MinableRecord>(records: T[], library: LibraryRule[]): MinableRecord[] {
  if (library.length === 0) return records.map(r => ({ ...r }));
  const rules = [...library].sort((a, b) => b.symbols.length - a.symbols.length);
  const out: MinableRecord[] = [];

  for (const run of groupByRun(records)) {
    let i = 0;
    let step = 0;
    while (i < run.length) {
      const hit = rules.find(rule =>
        rule.symbols.every((s, k) => run[i + k] !== undefined && run[i + k].symbol === s),
      );
      if (hit) {
        const window = run.slice(i, i + hit.symbols.length);
        out.push({
          runId: run[0].runId,
          step,
          symbol: hit.name,
          args: Object.assign({}, ...window.map(w => w.args)) as Record<string, unknown>,
        });
        i += hit.symbols.length;
      } else {
        out.push({ runId: run[0].runId, step, symbol: run[i].symbol, args: run[i].args });
        i += 1;
      }
      step += 1;
    }
  }

  return out;
}
