/**
 * mdlAccount — 收录与退役的同一个目标函数（ADL: TOOL-MDL-GROWTH.md §4.3 / M4 / M6）
 *
 *   L = Σ_τ |manifest(τ)| · S   +   Σ_t |t|
 *       ╰── 文法代价（每轮都付）  ╰── 语料代价（主项是观测 token）
 *
 * 收录 τ ⟺ ΔL < 0。退役用同一个 L，所以不需要第二套判据——这正是
 * utility problem（Minton 1988）里缺的那一半。
 */

export interface CorpusStep {
  symbol: string;
  actionTokens: number;
  obsTokens: number;
}

export interface LibraryEntry {
  name: string;
  costTokens: number;
}

/** 语料代价：动作 token + 进入上下文的观测 token（M10 两项都要） */
export function corpusCostTokens(corpus: CorpusStep[]): number {
  return corpus.reduce((sum, s) => sum + s.actionTokens + s.obsTokens, 0);
}

/** 文法代价：索引条目 token × 剩余步数预算 */
export function grammarCostTokens(library: LibraryEntry[], remainingSteps: number): number {
  return library.reduce((sum, e) => sum + e.costTokens, 0) * remainingSteps;
}

export function totalDescriptionLength(input: {
  library: LibraryEntry[];
  corpus: CorpusStep[];
  remainingSteps: number;
}): number {
  return grammarCostTokens(input.library, input.remainingSteps) + corpusCostTokens(input.corpus);
}

export interface ToolCandidateCost {
  name: string;
  /** 索引里这一条的 token */
  manifestCostTokens: number;
  /** 预期复用次数 k（由挖掘的历史频次估计） */
  support: number;
  /** 每次使用省下的 token，主项是被吞掉的中间观测 */
  savedTokensPerUse: number;
  /** 调用一次本身的 token */
  callCostTokens: number;
  /** 一次性写 + 测的成本 */
  buildCostTokens: number;
}

/**
 * ΔL(收录)。等价于经济不等式
 *   k·(c_inline − c_tool) > c_build + c_carry·S
 * 的移项形式；<0 才收。
 */
export function acceptDelta(
  cand: ToolCandidateCost,
  opts: { remainingSteps: number },
): number {
  const carry = cand.manifestCostTokens * opts.remainingSteps;
  const saving = cand.support * (cand.savedTokensPerUse - cand.callCostTokens);
  return cand.buildCostTokens + carry - saving;
}

export interface RetireCandidate {
  name: string;
  manifestCostTokens: number;
  /** 实际被调用的次数 */
  uses: number;
  savedTokensPerUse: number;
  callCostTokens: number;
}

/** ΔL(退役)。<0 表示删掉它总描述长度下降 → 退役 */
export function retireDelta(t: RetireCandidate, opts: { remainingSteps: number }): number {
  const freedCarry = t.manifestCostTokens * opts.remainingSteps;
  const lostSaving = t.uses * (t.savedTokensPerUse - t.callCostTokens);
  return lostSaving - freedCarry;
}

/**
 * utility problem 拐点：库里能容纳多少个工具，索引代价才追上节省。
 * 这是本设计最硬的一条可预先计算的预测（见 ADL §8）。
 */
export function crossoverStep(input: {
  perToolCostTokens: number;
  savedTokensPerStep: number;
}): number {
  if (input.perToolCostTokens <= 0) return Infinity;
  return input.savedTokensPerStep / input.perToolCostTokens;
}
