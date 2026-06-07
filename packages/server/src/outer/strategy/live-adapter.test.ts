/**
 * live-adapter 纯函数单测：burst 退出计数 / recentBursts / planInputKpis / 事件映射。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §4/§7
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlanInputKpis,
  buildRecentBursts,
  countBurstExitsSince,
  mapEnvEventsForPlan,
} from './live-adapter.js';
import type { TaskRecord } from '../inner-brain-registry.js';
import type { KpiRecord } from '../kpi-registry.js';

const T = Date.parse('2026-06-06T00:00:00.000Z');
const DAY = 86_400_000;

function task(o: Partial<TaskRecord> = {}): TaskRecord {
  return {
    instanceId: 'ib-x', workspaceId: 'task-ib-x', workDir: '/tmp', goal: 'g',
    originUser: 'u', status: 'RUNNING', startedAt: new Date(T - DAY).toISOString(), ...o,
  };
}

describe('countBurstExitsSince', () => {
  it('只数退出态且 finishedAt/abortedAt 晚于 since', () => {
    const tasks = [
      task({ status: 'DONE', finishedAt: new Date(T - 1000).toISOString() }), // 之前
      task({ status: 'DONE', finishedAt: new Date(T + 1000).toISOString() }), // 之后 ✓
      task({ status: 'ABORTED', abortedAt: new Date(T + 2000).toISOString() }), // 之后 ✓
      task({ status: 'RUNNING' }), // 非退出态
    ];
    expect(countBurstExitsSince(tasks, T)).toBe(2);
  });
  it('since=-Infinity（无上次战略）→ 数所有退出态', () => {
    const tasks = [task({ status: 'DONE', finishedAt: new Date(T).toISOString() }), task({ status: 'RUNNING' })];
    expect(countBurstExitsSince(tasks, -Infinity)).toBe(1);
  });
});

describe('buildRecentBursts', () => {
  it('映射 state/kpiId/abortReason，限量', () => {
    const tasks = [
      task({ instanceId: 'a', status: 'DONE', kpiId: 'k1' }),
      task({ instanceId: 'b', status: 'ABORTED', abortReason: 'stale_awaiting_timeout' }),
    ];
    const r = buildRecentBursts(tasks, 1);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ instanceId: 'a', state: 'DONE', kpiId: 'k1' });
  });
});

describe('buildPlanInputKpis', () => {
  it('带 momentum/kind/outcome digest', () => {
    const kpi = {
      kpiId: 'k1', description: '台湾情报收集', createdBy: 'u', createdAt: 'x',
      status: 'active', kind: 'ongoing', momentum: 3, bursts: [], consecutiveIdleBursts: 0,
      reflexionTrail: [],
      burstRunHistory: [{
        runId: 'r1', instanceId: 'ib', kpiId: 'k1', startedAt: 'x', finishedAt: 'x',
        exitStatus: 'DONE', charter: 'c', ticks: 1, deliverableCount: 0,
        outcomeEvaluation: {
          evaluatedAt: 'x', successConfirmed: false, confidence: 'high',
          failureReasons: [], evidenceSummary: '无产物', processReportDigest: '',
        },
      }],
    } as unknown as KpiRecord;
    const r = buildPlanInputKpis([kpi]);
    expect(r[0]).toMatchObject({ id: 'k1', status: 'active', kind: 'ongoing', momentum: 3 });
    expect(r[0]?.reflexionDigest).toContain('fail');
  });
});

describe('mapEnvEventsForPlan', () => {
  it('剥到 {sensorId,field,note}', () => {
    const r = mapEnvEventsForPlan([{ sensorId: 'innerBrains', field: 'awaiting', note: 'n', kind: 'threshold_crossed' }]);
    expect(r).toEqual([{ sensorId: 'innerBrains', field: 'awaiting', note: 'n' }]);
  });
});
