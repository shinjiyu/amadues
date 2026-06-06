/**
 * runStrategyPhase 编排单测：store→trigger→plan→writeCurrent→reap→dispatch select 端到端（FakeLLM + fake reaper）。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §4
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStrategyPhase, StrategyStore } from './index.js';
import type { ReaperDeps } from './stale-burst-reaper.js';
import type { TaskRecord } from '../inner-brain-registry.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-runphase-'));
});
afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const NOW = Date.parse('2026-06-06T00:00:00.000Z');
const DAY = 86_400_000;

function staleAwaiting(): TaskRecord {
  return {
    instanceId: 'ib-stale', workspaceId: 'task-ib-stale', workDir: '/tmp/s', goal: 'g',
    originUser: 'u', status: 'AWAITING',
    startedAt: new Date(NOW - 9 * DAY).toISOString(),
    lastTickAt: new Date(NOW - 9 * DAY).toISOString(),
  };
}

function fakeReaper(tasks: TaskRecord[]): { deps: ReaperDeps; aborted: string[] } {
  const map = new Map(tasks.map((t) => [t.instanceId, t]));
  const aborted: string[] = [];
  return {
    aborted,
    deps: {
      getTask: (id) => map.get(id),
      abort: (id) => {
        aborted.push(id);
        const t = map.get(id);
        if (t) t.status = 'ABORTED';
      },
      now: () => NOW,
    },
  };
}

describe('runStrategyPhase', () => {
  it('首次（无 strategy）→ 规划 + 写 current.json + 杀超时 AWAITING + dispatch 选 focusOrder 首项', async () => {
    const tasks = [staleAwaiting()];
    const { deps: reaperDeps, aborted } = fakeReaper(tasks);

    const callLlm = async () =>
      JSON.stringify({
        theory: '情报收集最高价值',
        whyNow: '有新线索',
        nextExpectation: '扩源',
        focusOrder: ['k1', 'k2'],
      });

    const r = await runStrategyPhase({
      dataRoot: tmpRoot,
      agentId: 'a',
      planInputKpis: [
        { id: 'k1', title: '台湾', status: 'active', momentum: 2 },
        { id: 'k2', title: '日本', status: 'active', momentum: 0 },
      ],
      recentBursts: [],
      envEvents: [],
      tasks,
      triggerCtx: {
        burstExitsSinceLast: 0,
        msSinceLastPlan: Number.POSITIVE_INFINITY,
        userMessageSinceLast: false,
        hasUnconsumedThresholdEvent: false,
        needsStrategyReview: false,
      },
      activeKpiIds: new Set(['k1', 'k2']),
      canSpawn: true,
      onCooldown: () => false,
      callLlm,
      reaperDeps,
      now: () => NOW,
    });

    expect(r.reevaluated).toBe(true);
    expect(r.triggers).toContain('no_strategy');
    expect(r.planRejected).toBe(false);
    expect(r.abortedIds).toEqual(['ib-stale']);
    expect(r.dispatch).toEqual({ kind: 'kpi', kpiId: 'k1' });

    // current.json 已落盘
    const persisted = new StrategyStore(tmpRoot).loadCurrent();
    expect(persisted?.focusOrder).toEqual(['k1', 'k2']);
    // journal 留痕
    expect(new StrategyStore(tmpRoot).readJournal()).toHaveLength(1);
    expect(aborted).toEqual(['ib-stale']);
  });

  it('稳定态（已有 strategy 且无触发）→ 不重规划，仍跑 reaper 兜底', async () => {
    // 预置 current.json（updatedAt=now，使 msSinceLastPlan=0 不触发 onMs）
    new StrategyStore(tmpRoot).writeCurrent({
      version: 1, agentId: 'a', updatedAt: new Date(NOW).toISOString(),
      activeKpis: ['k1'], focusOrder: ['k1'], pausedKpis: [],
      theory: 't', whyNow: 'w', recentLessons: [], nextExpectation: 'n', cullDirectives: [],
      staleAwaitingPolicy: { maxAwaitingMs: 7 * DAY, requireProgressSignalAfterMs: 3 * DAY },
      reEvaluateAfter: { onBurstExits: 1, onMs: 6 * 60 * 60 * 1000, onEvents: [] },
    });
    const tasks = [staleAwaiting()];
    const { deps: reaperDeps } = fakeReaper(tasks);
    let llmCalled = false;

    const r = await runStrategyPhase({
      dataRoot: tmpRoot, agentId: 'a',
      planInputKpis: [{ id: 'k1', title: '台湾', status: 'active', momentum: 1 }],
      recentBursts: [], envEvents: [], tasks,
      triggerCtx: {
        burstExitsSinceLast: 0, msSinceLastPlan: 0, userMessageSinceLast: false,
        hasUnconsumedThresholdEvent: false, needsStrategyReview: false,
      },
      activeKpiIds: new Set(['k1']), canSpawn: true, onCooldown: () => false,
      callLlm: async () => { llmCalled = true; return '{}'; },
      reaperDeps, now: () => NOW,
    });

    expect(r.reevaluated).toBe(false);
    expect(llmCalled).toBe(false);          // 走 cache，不烧 LLM
    expect(r.abortedIds).toEqual(['ib-stale']); // reaper 仍兜底
    expect(r.dispatch).toEqual({ kind: 'kpi', kpiId: 'k1' });
  });
});
