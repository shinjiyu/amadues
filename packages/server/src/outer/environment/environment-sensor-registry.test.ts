/**
 * environmentSensorRegistry 单测：collect 扇入 + 派生注入 + rate_limited 缓存 + 重复 id。
 * ADL: doc/structurizr/ENVIRONMENT-MODEL.md §3-5
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentSensorRegistry } from './sensor-registry.js';
import { EnvironmentJournal } from './journal.js';
import type { EnvironmentSensor, SensorContext } from './environment-types.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-envreg-'));
});
afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function ctx(now: number): SensorContext {
  return {
    agentId: 'agent-x',
    now,
    registry: { list: () => [] } as unknown as SensorContext['registry'],
    defaultThreadId: 'global',
    getOrchestratorStats: () => ({ queuedTotal: 0, activeThreads: 0 }),
    getLlmUsageSnapshot: () => ({ inFlight: 0, tokensLast1h: { prompt: 0, completion: 0, total: 0 }, callsLast1h: 0 }),
    getParticipationState: () => ({ lastProactiveAt: 0, proactiveCount5min: 0 }),
    getProcessMemory: () => ({ heapUsed: 1024 * 1024, rss: 2 * 1024 * 1024 }),
  };
}

describe('EnvironmentSensorRegistry.collect', () => {
  it('内置 sensor 全部产出 facet', () => {
    const reg = new EnvironmentSensorRegistry();
    const { snapshot } = reg.collect(ctx(0));
    for (const id of ['innerBrains', 'llmUsage', 'inbound', 'im', 'process', 'time']) {
      expect(snapshot.facets[id]).toBeDefined();
    }
    expect(snapshot.agentId).toBe('agent-x');
  });

  it('给 journal：record + 第二 tick 注入 derived（token 速率）', () => {
    const counters = { total: 0 };
    const llmStub: EnvironmentSensor = {
      id: 'llmUsage', label: 'l', description: 'l', cadence: 'every_tick',
      read: () => ({ inFlight: 0, tokensLast1h: { prompt: 0, completion: 0, total: counters.total }, callsLast1h: 0 }),
      derive: (h) => {
        const out: Record<string, number> = {};
        if (h.samples.length < 2) return out;
        const first = h.samples[0]!.data as { tokensLast1h: { total: number } };
        const last = h.samples[h.samples.length - 1]!.data as { tokensLast1h: { total: number } };
        const minutes = (h.samples[h.samples.length - 1]!.at - h.samples[0]!.at) / 60_000;
        out['tokensRatePerMin'] = (last.tokensLast1h.total - first.tokensLast1h.total) / minutes;
        return out;
      },
    };
    const reg = new EnvironmentSensorRegistry([llmStub]);
    const journal = new EnvironmentJournal(tmpRoot, { ringSize: 8 });

    counters.total = 0;
    reg.collect(ctx(0), journal);
    counters.total = 600;
    const { snapshot } = reg.collect(ctx(2 * 60_000), journal);

    expect(snapshot.facets['llmUsage']?.derived['tokensRatePerMin']).toBe(300);
    // current.json 带 derived
    const cur = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'environment', 'current.json'), 'utf8'));
    expect(cur.facets.llmUsage.derived.tokensRatePerMin).toBe(300);
    // ring 不因二次 updateCurrent 而重复（2 tick → 2 样本）
    expect(journal.recentSnapshots()).toHaveLength(2);
  });

  it('rate_limited sensor 在 minInterval 内返回缓存 staleness=cached', () => {
    let reads = 0;
    const slow: EnvironmentSensor = {
      id: 'slow', label: 's', description: 's',
      cadence: 'rate_limited', cadenceConfig: { minIntervalMs: 10_000 },
      read: () => { reads += 1; return { n: reads }; },
    };
    const reg = new EnvironmentSensorRegistry([slow]);
    const a = reg.collect(ctx(0)).snapshot.facets['slow'];
    const b = reg.collect(ctx(5_000)).snapshot.facets['slow']; // 间隔 < 10s
    const c = reg.collect(ctx(20_000)).snapshot.facets['slow']; // 间隔 > 10s
    expect(a?.staleness).toBe('fresh');
    expect(b?.staleness).toBe('cached');
    expect(b?.data).toEqual(a?.data);
    expect(c?.staleness).toBe('fresh');
    expect(reads).toBe(2);
  });

  it('重复 sensor id 抛错', () => {
    const reg = new EnvironmentSensorRegistry([]);
    const s = { id: 'dup', label: 'd', description: 'd', cadence: 'every_tick', read: () => ({}) } as EnvironmentSensor;
    reg.register(s);
    expect(() => reg.register(s)).toThrow(/duplicate/);
  });
});
