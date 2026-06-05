import { describe, expect, it } from 'vitest';

import { evaluateBurstStall } from './burst-stall-evaluator.js';
import type { InnerMemory } from './types.js';

function mem(partial: Partial<InnerMemory>): InnerMemory {
  return {
    constraints: [],
    facts: [],
    node_results: {},
    last_failure: null,
    ...partial,
  };
}

describe('evaluateBurstStall', () => {
  it('not stalled with zero nodes', () => {
    const v = evaluateBurstStall({ memory: mem({}) });
    expect(v.stalled).toBe(false);
  });

  it('multi_cap_no_facts', () => {
    const v = evaluateBurstStall({
      memory: mem({
        node_results: {
          a: { nodeInstId: 'a', ref: 'preset/base', ok: false, status: 'capped', at: '' },
          b: { nodeInstId: 'b', ref: 'preset/base', ok: false, status: 'capped', at: '' },
        },
      }),
    });
    expect(v.stalled).toBe(true);
    expect(v.signals).toContain('multi_cap_no_facts');
    expect(v.severity).toBe('warn');
  });

  it('capped_nodes_3 is critical', () => {
    const nr: InnerMemory['node_results'] = {};
    for (const id of ['a', 'b', 'c']) {
      nr[id] = { nodeInstId: id, ref: 'preset/base', ok: false, status: 'capped', at: '' };
    }
    const v = evaluateBurstStall({ memory: mem({ node_results: nr }) });
    expect(v.stalled).toBe(true);
    expect(v.signals).toContain('capped_nodes_3');
    expect(v.severity).toBe('critical');
  });

  it('long_run_no_outcome when wall exceeds threshold', () => {
    const v = evaluateBurstStall({
      memory: mem({}),
      deliverableCount: 0,
      startedAtMs: Date.now() - 20 * 60_000,
      longRunMs: 15 * 60_000,
    });
    expect(v.stalled).toBe(true);
    expect(v.signals).toContain('long_run_no_outcome');
    expect(v.severity).toBe('critical');
  });

  it('not stalled when capped but has facts', () => {
    const v = evaluateBurstStall({
      memory: mem({
        facts: ['answer=8'],
        node_results: {
          a: { nodeInstId: 'a', ref: 'preset/base', ok: false, status: 'capped', at: '' },
          b: { nodeInstId: 'b', ref: 'preset/base', ok: true, at: '' },
        },
      }),
    });
    expect(v.signals).not.toContain('multi_cap_no_facts');
  });
});
