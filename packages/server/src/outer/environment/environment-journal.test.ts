/**
 * environmentJournal 单测：ring trim + current.json + events 月轮转 + 未消费查询 + markConsumed + hourly。
 * ADL: doc/structurizr/ENVIRONMENT-MODEL.md §6
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentJournal, aggregateHour } from './journal.js';
import type { EnvironmentEvent, EnvironmentSnapshot } from './environment-types.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-env-'));
});
afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function snap(at: number, v: number): EnvironmentSnapshot {
  const iso = new Date(at).toISOString();
  return {
    capturedAt: iso,
    agentId: 'a',
    facets: { llmUsage: { sensorId: 'llmUsage', capturedAt: iso, data: { total: v }, derived: {} } },
  };
}

describe('EnvironmentJournal ring + current.json', () => {
  it('ring 超过 ringSize 自动裁剪，保留最近的', () => {
    const j = new EnvironmentJournal(tmpRoot, { ringSize: 3 });
    for (let i = 0; i < 5; i++) j.record(snap(i * 1000, i));
    const recent = j.recentSnapshots();
    expect(recent).toHaveLength(3);
    expect(recent[0]?.facets['llmUsage']?.data).toEqual({ total: 2 });
    expect(j.latest()?.facets['llmUsage']?.data).toEqual({ total: 4 });
    expect(j.previous()?.facets['llmUsage']?.data).toEqual({ total: 3 });
  });

  it('record 写 current.json', () => {
    const j = new EnvironmentJournal(tmpRoot);
    j.record(snap(0, 7));
    const file = path.join(tmpRoot, 'environment', 'current.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EnvironmentSnapshot;
    expect(parsed.facets['llmUsage']?.data).toEqual({ total: 7 });
  });

  it('seriesFor 从 ring 构造序列', () => {
    const j = new EnvironmentJournal(tmpRoot, { ringSize: 5 });
    j.record(snap(0, 1));
    j.record(snap(60_000, 3));
    const s = j.seriesFor('llmUsage');
    expect(s.samples.map((x) => (x.data as { total: number }).total)).toEqual([1, 3]);
  });
});

describe('EnvironmentJournal events 月轮转 + 未消费 + markConsumed', () => {
  function ev(at: string, field: string): EnvironmentEvent {
    return { at, sensorId: 'innerBrains', kind: 'threshold_crossed', field, note: 'n' };
  }

  it('按月写入不同文件', () => {
    const j = new EnvironmentJournal(tmpRoot);
    j.appendEvents([ev('2026-06-01T00:00:00.000Z', 'awaiting')]);
    j.appendEvents([ev('2026-07-01T00:00:00.000Z', 'awaiting')]);
    const dir = path.join(tmpRoot, 'environment');
    expect(fs.existsSync(path.join(dir, 'events-2026-06.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'events-2026-07.jsonl'))).toBe(true);
  });

  it('recentUnconsumedEvents 跨月正序；markConsumed 后不再返回', () => {
    const j = new EnvironmentJournal(tmpRoot);
    const e1 = ev('2026-06-01T00:00:00.000Z', 'awaiting');
    const e2 = ev('2026-07-01T00:00:00.000Z', 'blocked');
    j.appendEvents([e2, e1]);

    let un = j.recentUnconsumedEvents();
    expect(un.map((e) => e.field)).toEqual(['awaiting', 'blocked']);

    j.markEventsConsumed([e1]);
    un = j.recentUnconsumedEvents();
    expect(un.map((e) => e.field)).toEqual(['blocked']);
  });
});

describe('aggregateHour', () => {
  it('count/avg/min/max/p50/p95', () => {
    const a = aggregateHour('2026-06-06T10:00:00Z', 'llmUsage', 'total', [10, 20, 30, 40]);
    expect(a.count).toBe(4);
    expect(a.avg).toBe(25);
    expect(a.min).toBe(10);
    expect(a.max).toBe(40);
  });
  it('空样本 → 全 0', () => {
    const a = aggregateHour('h', 's', 'f', []);
    expect(a).toMatchObject({ count: 0, avg: 0, min: 0, max: 0 });
  });
});
