import { describe, expect, it } from 'vitest';
import {
  bigramJaccard,
  isSimilarKpiDescription,
  longestCommonSubstringLen,
  normalizeForSimilarity,
} from './kpi-description-similarity.js';

describe('kpi-description-similarity', () => {
  it('归一化去标点/空白/mention', () => {
    expect(normalizeForSimilarity('@Gin 台湾 情报，收集！')).toBe('台湾情报收集');
  });

  it('同一目标 → similar', () => {
    expect(
      isSimilarKpiDescription(
        '台湾情报常态收集，每天中午晚上汇报',
        '继续做台湾情报常态收集，每天汇报',
      ),
    ).toBe(true);
  });

  it('不同目标 → not similar', () => {
    expect(
      isSimilarKpiDescription('台湾情报常态收集', '帮我翻译这份英文文档'),
    ).toBe(false);
  });

  it('长公共子串触发相似', () => {
    expect(longestCommonSubstringLen('每天监控竞品价格变化', '帮我每天监控竞品价格')).toBeGreaterThanOrEqual(6);
    expect(isSimilarKpiDescription('每天监控竞品价格变化', '帮我每天监控竞品价格')).toBe(true);
  });

  it('Jaccard 在 [0,1]', () => {
    const j = bigramJaccard('abc', 'abc');
    expect(j).toBeGreaterThan(0.9);
    expect(bigramJaccard('abc', 'xyz')).toBe(0);
  });
});
