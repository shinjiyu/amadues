import { describe, expect, it } from 'vitest';

import {
  migrateLegacyFacts,
  recordFactGoverned,
  selectFactsForPrompt,
  sweepFacts,
  syncLegacyFactsArray,
} from './fact-governor.js';
import type { FactRecord } from './types.js';

const NOW = new Date('2026-06-07T12:00:00.000Z');

function rec(content: string, topic: string, at: string, extra: Partial<FactRecord> = {}): FactRecord {
  return {
    id: `kn-${topic.replace(/\W/g, '-')}`,
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

describe('recordFactGoverned', () => {
  it('creates a new active record', () => {
    const { action, records } = recordFactGoverned([], { content: 'svc at :8080' }, NOW);
    expect(action).toBe('created');
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('active');
  });

  it('bumps citeCount on exact content duplicate', () => {
    const first = recordFactGoverned([], { content: 'svc at :8080' }, NOW);
    const second = recordFactGoverned(first.records, { content: 'svc at :8080' }, NOW);
    expect(second.action).toBe('bumped');
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.citeCount).toBe(1);
  });

  it('supersedes same-topic active record', () => {
    const first = recordFactGoverned(
      [],
      { content: '章节序号用 .serial-input', topic: 'fanqie.ui.editor' },
      NOW,
    );
    const second = recordFactGoverned(
      first.records,
      { content: '章节序号框无法定位', topic: 'fanqie.ui.editor' },
      NOW,
    );
    expect(second.action).toBe('superseded');
    const active = second.records.filter(r => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toContain('无法定位');
    const old = second.records.find(r => r.status === 'superseded');
    expect(old?.id).toBe(first.record?.id);
    expect(active[0]?.supersedes).toBe(old?.id);
  });

  it('supersedes near-duplicate active record with different topic', () => {
    const first = recordFactGoverned(
      [],
      { content: 'fanqienovel 第6章破局之棋已成功发布 chapter_passed_num=6', topic: 'general.aaaa' },
      NOW,
    );
    const second = recordFactGoverned(
      first.records,
      { content: 'fanqienovel 第6章破局之棋已成功发布 API确认 chapter_passed_num 从5变6', topic: 'general.bbbb' },
      NOW,
    );
    expect(second.action).toBe('superseded');
    expect(second.records.filter(r => r.status === 'active')).toHaveLength(1);
  });
});

describe('sweepFacts', () => {
  it('cold-supersedes old uncited hypothesis facts', () => {
    const records = [
      rec('old fact', 'general.old', '2026-05-01T00:00:00.000Z'),
      rec('fresh fact', 'general.new', '2026-06-06T00:00:00.000Z'),
    ];
    const { records: out, result } = sweepFacts(records, {
      coldDays: 14,
      maxActive: 60,
      now: NOW,
    });
    expect(result.superseded.some(s => s.reason === 'cold')).toBe(true);
    expect(out.filter(r => r.status === 'active').map(r => r.content)).toContain('fresh fact');
  });

  it('quota-supersedes lowest-score facts', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      rec(`fact ${i}`, `topic.${i}`, '2026-06-06T00:00:00.000Z', { citeCount: i }),
    );
    const { result } = sweepFacts(records, { maxActive: 3, headroomRatio: 0, now: NOW });
    expect(result.remainingActive).toBeLessThanOrEqual(3);
    expect(result.superseded.some(s => s.reason === 'quota')).toBe(true);
  });
});

describe('selectFactsForPrompt', () => {
  it('caps active facts and reports omitted count', () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      rec(`fact ${i}`, `topic.${i}`, '2026-06-06T00:00:00.000Z'),
    );
    const { lines, omitted, section } = selectFactsForPrompt(records, { max: 5 });
    expect(lines).toHaveLength(5);
    expect(omitted).toBe(25);
    expect(section).toContain('另有 25 条事实已省略');
  });

  it('excludes superseded records', () => {
    const records = [
      rec('active', 't1', '2026-06-06T00:00:00.000Z'),
      rec('gone', 't2', '2026-06-06T00:00:00.000Z', { status: 'superseded' }),
    ];
    const { lines } = selectFactsForPrompt(records, { max: 10 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('active');
  });
});

describe('migrateLegacyFacts', () => {
  it('converts string facts to active records', () => {
    const records = migrateLegacyFacts(['a', 'b'], '2026-06-01T00:00:00.000Z');
    expect(records).toHaveLength(2);
    expect(syncLegacyFactsArray(records)).toEqual(['a', 'b']);
  });
});
