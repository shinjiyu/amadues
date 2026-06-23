/**
 * KPI 描述相似度（去重）— IM-INBOUND-INTENT-ROUTING.md §5
 *
 * 用于：显式 KPI 意图命中时，若同 origin 已有近似 active KPI，则降级为 kpi_update
 * 而非重复 create。纯函数，便于单测。
 */

/** 归一化：去标点/空白/@mention，转小写 */
export function normalizeForSimilarity(text: string): string {
  return text
    .replace(/@[\w\u4e00-\u9fff-]+/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

function charBigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** 字符二元组 Jaccard 相似度 [0,1] */
export function bigramJaccard(a: string, b: string): number {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return 0;
  const ba = charBigrams(na);
  const bb = charBigrams(nb);
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  const union = ba.size + bb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 最长公共子串长度（归一化后） */
export function longestCommonSubstringLen(a: string, b: string): number {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return 0;
  let best = 0;
  let prev = new Array(nb.length + 1).fill(0);
  for (let i = 1; i <= na.length; i++) {
    const cur = new Array(nb.length + 1).fill(0);
    for (let j = 1; j <= nb.length; j++) {
      if (na[i - 1] === nb[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

export interface SimilarityOptions {
  /** Jaccard 阈值（默认 0.5） */
  jaccardThreshold?: number;
  /** 公共子串长度阈值（默认 6 个字符） */
  substringThreshold?: number;
}

/**
 * 判定两条 KPI 描述是否「同一目标」：
 * - 字符二元组 Jaccard ≥ jaccardThreshold，或
 * - 最长公共子串 ≥ substringThreshold（捕捉「再帮我盯一下台湾情报」vs「台湾情报常态收集」）
 */
export function isSimilarKpiDescription(
  a: string,
  b: string,
  opts: SimilarityOptions = {},
): boolean {
  const jaccardThreshold = opts.jaccardThreshold ?? 0.5;
  const substringThreshold = opts.substringThreshold ?? 6;
  if (bigramJaccard(a, b) >= jaccardThreshold) return true;
  if (longestCommonSubstringLen(a, b) >= substringThreshold) return true;
  return false;
}
