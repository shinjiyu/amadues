/**
 * dispatchByStrategy 单测：focusOrder∩active 选 KPI + cooldown + 资源闸门 + strategy 缺失。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §8/§10
 */
import { describe, expect, it } from 'vitest';
import { selectStrategyDispatch } from './dispatch-by-strategy.js';
import {
  DEFAULT_REEVALUATE_POLICY,
  DEFAULT_STALE_AWAITING_POLICY,
  type StrategyArtifact,
} from './strategy-types.js';

function strat(focusOrder: string[]): StrategyArtifact {
  return {
    version: 1, agentId: 'a', updatedAt: 'now',
    activeKpis: focusOrder, focusOrder, pausedKpis: [],
    theory: 't', whyNow: 'w', recentLessons: [], nextExpectation: 'n',
    cullDirectives: [],
    staleAwaitingPolicy: { ...DEFAULT_STALE_AWAITING_POLICY },
    reEvaluateAfter: { ...DEFAULT_REEVALUATE_POLICY },
  };
}

const noCooldown = () => false;

describe('selectStrategyDispatch', () => {
  it('strategy 缺失 → none_active(no_strategy)', () => {
    const r = selectStrategyDispatch(null, { activeKpiIds: new Set(['k1']), canSpawn: true, onCooldown: noCooldown });
    expect(r).toEqual({ kind: 'none_active', reason: 'no_strategy' });
  });

  it('按 focusOrder 顺序挑第一个 active', () => {
    const r = selectStrategyDispatch(strat(['k2', 'k1']), {
      activeKpiIds: new Set(['k1', 'k2']), canSpawn: true, onCooldown: noCooldown,
    });
    expect(r).toEqual({ kind: 'kpi', kpiId: 'k2' });
  });

  it('focusOrder 首项已非 active（被 registry paused）→ 跳到下一个', () => {
    const r = selectStrategyDispatch(strat(['k2', 'k1']), {
      activeKpiIds: new Set(['k1']), canSpawn: true, onCooldown: noCooldown,
    });
    expect(r).toEqual({ kind: 'kpi', kpiId: 'k1' });
  });

  it('交集为空 → none_active', () => {
    const r = selectStrategyDispatch(strat(['k2']), {
      activeKpiIds: new Set(['k9']), canSpawn: true, onCooldown: noCooldown,
    });
    expect(r.kind).toBe('none_active');
  });

  it('资源闸门 canSpawn=false → none_active(resource_gate)', () => {
    const r = selectStrategyDispatch(strat(['k1']), {
      activeKpiIds: new Set(['k1']), canSpawn: false, onCooldown: noCooldown,
    });
    expect(r).toEqual({ kind: 'none_active', reason: 'resource_gate' });
  });

  it('全部 cooldown → none_active(all_on_cooldown)', () => {
    const r = selectStrategyDispatch(strat(['k1', 'k2']), {
      activeKpiIds: new Set(['k1', 'k2']), canSpawn: true, onCooldown: () => true,
    });
    expect(r).toEqual({ kind: 'none_active', reason: 'all_on_cooldown' });
  });

  it('跳过 cooldown 的，挑下一个', () => {
    const r = selectStrategyDispatch(strat(['k1', 'k2']), {
      activeKpiIds: new Set(['k1', 'k2']), canSpawn: true, onCooldown: (id) => id === 'k1',
    });
    expect(r).toEqual({ kind: 'kpi', kpiId: 'k2' });
  });
});
