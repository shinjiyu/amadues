import { describe, expect, it } from 'vitest';
import {
  appendPlanReferences,
  formatPlanReferenceHits,
  MAX_PLAN_REFERENCES,
  normalizePlanReferenceSources,
} from './plan-reference-port.js';

describe('plan-reference-port helpers', () => {
  it('formatPlanReferenceHits marks unverified reference', () => {
    const text = formatPlanReferenceHits([
      { source: 'archive', title: 't1', snippet: 'api 死路' },
    ]);
    expect(text).toContain('未验证');
    expect(text).toContain('禁止写入 facts');
    expect(text).toContain('api 死路');
  });

  it('appendPlanReferences caps history', () => {
    const base = Array.from({ length: MAX_PLAN_REFERENCES }, (_, i) => ({
      source: 'archive' as const,
      title: `old-${i}`,
      snippet: 'x',
      query: 'q',
      retrievedAt: '2026-01-01T00:00:00.000Z',
    }));
    const merged = appendPlanReferences(base, 'new-q', [
      { source: 'peer', title: 'p1', snippet: 'peer hint' },
    ]);
    expect(merged).toHaveLength(MAX_PLAN_REFERENCES);
    expect(merged[merged.length - 1]?.title).toBe('p1');
  });

  it('normalizePlanReferenceSources drops unknown', () => {
    expect(normalizePlanReferenceSources(['archive', 'bogus' as 'archive'])).toEqual(['archive']);
  });
});
