import { describe, expect, it } from 'vitest';

import {
  applyFactConflictFlags,
  detectFactConflicts,
  deriveFactDomain,
  factPolarity,
  reconcileFactConflicts,
  resolveStaleStatusFacts,
} from './fact-conflict.js';
import type { FactRecord } from './types.js';

const NOW = new Date('2026-06-07T12:00:00.000Z');

function rec(
  id: string,
  content: string,
  topic: string,
  at: string,
  extra: Partial<FactRecord> = {},
): FactRecord {
  return {
    id,
    topic,
    content,
    status: 'active',
    confidence: 'hypothesis',
    source: { at, via: 'record_fact' },
    citeCount: 0,
    tags: [],
    ...extra,
  };
}

describe('deriveFactDomain', () => {
  it('maps publish status topics to fanqie.publish.status', () => {
    expect(deriveFactDomain('fanqie.publish.status', 'chapter_passed_num=5')).toBe(
      'fanqie.publish.status',
    );
  });

  it('maps draft strategy to fanqie.publish.draft', () => {
    expect(deriveFactDomain('general.abc', '每次导航应 newchapter_0 新草稿')).toBe(
      'fanqie.publish.draft',
    );
  });
});

describe('factPolarity', () => {
  it('detects positive and negative', () => {
    expect(factPolarity('第5章已成功发布')).toBe('positive');
    expect(factPolarity('纯 API 发布不可用')).toBe('negative');
  });
});

describe('detectFactConflicts', () => {
  it('flags opposite polarity in same publish domain', () => {
    const records = [
      rec('a', '第5章已成功发布 chapter_passed_num=5', 'fanqie.publish.status', '2026-06-01T00:00:00.000Z'),
      rec('b', '第5章待发布 chapter_passed_num=4 不可用', 'fanqie.publish.status', '2026-06-02T00:00:00.000Z'),
    ];
    const conflicts = detectFactConflicts(records, NOW);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0]?.domain).toBe('fanqie.publish.status');
  });

  it('flags draft URL strategy conflicts', () => {
    const records = [
      rec('a', '每次导航必须 newchapter_0 新草稿 item_id 不同 已验证可行', 'fanqie.publish.draft', '2026-06-01T00:00:00.000Z'),
      rec('b', '重复使用同一 draft URL 不可行', 'fanqie.publish.draft', '2026-06-02T00:00:00.000Z'),
    ];
    const conflicts = detectFactConflicts(records, NOW);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('resolveStaleStatusFacts', () => {
  it('supersedes older fanqie.publish.status facts', () => {
    const records = [
      rec('old', 'chapter_passed_num=4 第5章待发布', 'fanqie.publish.status', '2026-06-01T00:00:00.000Z'),
      rec('new', 'chapter_passed_num=6 第6章已发布', 'fanqie.publish.status', '2026-06-06T00:00:00.000Z'),
    ];
    const { records: out, supersededIds } = resolveStaleStatusFacts(records);
    expect(supersededIds).toContain('old');
    expect(out.find(r => r.id === 'new')?.status).toBe('active');
    expect(out.find(r => r.id === 'old')?.status).toBe('superseded');
  });
});

describe('reconcileFactConflicts', () => {
  it('combines stale resolve, conflict flags, and fact_conflicts output', () => {
    const records = [
      rec('old', 'chapter_passed_num=4', 'fanqie.publish.status', '2026-06-01T00:00:00.000Z'),
      rec('new', 'chapter_passed_num=6 已成功发布', 'fanqie.publish.status', '2026-06-06T00:00:00.000Z'),
      rec('d1', '每次 newchapter_0 新草稿可行', 'fanqie.publish.draft', '2026-06-03T00:00:00.000Z'),
      rec('d2', '重复使用 draft URL 不可用', 'fanqie.publish.draft', '2026-06-04T00:00:00.000Z'),
    ];
    const { records: out, conflicts, staleStatusSuperseded } = reconcileFactConflicts(records, NOW);
    expect(staleStatusSuperseded).toContain('old');
    expect(conflicts.some(c => c.domain === 'fanqie.publish.draft')).toBe(true);
    const flagged = applyFactConflictFlags(out, conflicts);
    expect(flagged.find(r => r.id === 'd1')?.needsReconcile).toBe(true);
    expect(flagged.find(r => r.id === 'd2')?.needsReconcile).toBe(true);
  });
});
