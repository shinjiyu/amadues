/**
 * strategyStore 单测：current.json CRUD + journal 月轮转。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §11
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrategyStore } from './strategy-store.js';
import {
  DEFAULT_REEVALUATE_POLICY,
  DEFAULT_STALE_AWAITING_POLICY,
  type StrategyArtifact,
} from './strategy-types.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-strat-'));
});
afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function artifact(overrides: Partial<StrategyArtifact> = {}): StrategyArtifact {
  return {
    version: 1,
    agentId: 'a',
    updatedAt: '2026-06-06T00:00:00.000Z',
    activeKpis: ['k1'],
    focusOrder: ['k1'],
    pausedKpis: [],
    theory: 't',
    whyNow: 'w',
    recentLessons: [],
    nextExpectation: 'n',
    cullDirectives: [],
    staleAwaitingPolicy: { ...DEFAULT_STALE_AWAITING_POLICY },
    reEvaluateAfter: { ...DEFAULT_REEVALUATE_POLICY },
    ...overrides,
  };
}

describe('StrategyStore', () => {
  it('loadCurrent 无文件返回 null', () => {
    expect(new StrategyStore(tmpRoot).loadCurrent()).toBeNull();
  });

  it('writeCurrent 后 loadCurrent 往返一致', () => {
    const s = new StrategyStore(tmpRoot);
    const a = artifact({ focusOrder: ['k2', 'k1'] });
    s.writeCurrent(a);
    expect(s.loadCurrent()).toEqual(a);
    expect(fs.existsSync(path.join(tmpRoot, 'strategy', 'current.json'))).toBe(true);
  });

  it('appendJournal 按月分文件，readJournal 合并', () => {
    const s = new StrategyStore(tmpRoot);
    s.appendJournal({
      at: '2026-06-01T00:00:00.000Z', triggers: ['no_strategy'],
      activeKpisBefore: [], activeKpisAfter: ['k1'], focusOrderBefore: [], focusOrderAfter: ['k1'],
      cullDirectivesEmitted: 0, durationMs: 5,
    });
    s.appendJournal({
      at: '2026-07-01T00:00:00.000Z', triggers: ['on_ms'],
      activeKpisBefore: ['k1'], activeKpisAfter: ['k1'], focusOrderBefore: ['k1'], focusOrderAfter: ['k1'],
      cullDirectivesEmitted: 1, durationMs: 7,
    });
    const dir = path.join(tmpRoot, 'strategy');
    expect(fs.existsSync(path.join(dir, 'journal-2026-06.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'journal-2026-07.jsonl'))).toBe(true);
    const rows = s.readJournal();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.triggers).toEqual(['no_strategy']);
    expect(rows[1]?.cullDirectivesEmitted).toBe(1);
  });
});
