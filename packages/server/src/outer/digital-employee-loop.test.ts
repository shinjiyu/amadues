import { describe, expect, it, vi } from 'vitest';

import { DigitalEmployeeLoop, type DigitalEmployeeEnvironment } from './digital-employee-loop.js';
import type { SelfWorkProposal } from './self-work-policy.js';

const proposal: SelfWorkProposal = {
  kpiId: 'kpi-1',
  action: '调研同类小说',
  expectedOutcome: '五条市场观察',
  reason: '提升后续选题质量',
  strategyId: 'research_first',
};

function environment(running = 0): DigitalEmployeeEnvironment {
  return {
    capacity: {
      available: running === 0,
      freeInnerSlots: running === 0 ? 1 : 0,
      reason: running === 0 ? undefined : 'running_inner=1>=1',
    },
    activeKpis: [{ kpiId: 'kpi-1', status: 'active' }],
    pendingDependencies: [],
    runningConflicts: [],
    recentActions: [],
  };
}

describe('DigitalEmployeeLoop', () => {
  it('prioritizes a due calendar commitment over self work', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const propose = vi.fn().mockResolvedValue(proposal);
    const dispatchProposal = vi.fn();
    const loop = new DigitalEmployeeLoop({
      collectEnvironment: vi.fn().mockResolvedValue(environment()),
      calendar: {
        listDue: vi.fn().mockResolvedValue([{ id: 'due-1', priority: 0 }]),
        execute,
      },
      selfWorkPolicy: { propose },
      dispatchProposal,
      maxDispatchesPerTrigger: 1,
    });

    const result = await loop.trigger('calendar_due');
    expect(result.dispatched).toBe(1);
    expect(execute).toHaveBeenCalledWith('due-1');
    expect(propose).not.toHaveBeenCalled();
    expect(dispatchProposal).not.toHaveBeenCalled();
  });

  it('sleeps without capacity and leaves a due commitment untouched', async () => {
    const execute = vi.fn();
    const loop = new DigitalEmployeeLoop({
      collectEnvironment: vi.fn().mockResolvedValue(environment(1)),
      calendar: {
        listDue: vi.fn().mockResolvedValue([{ id: 'due-1', priority: 0 }]),
        execute,
      },
      selfWorkPolicy: { propose: vi.fn() },
      dispatchProposal: vi.fn(),
    });
    const result = await loop.trigger('calendar_due');
    expect(result.reason).toContain('running_inner');
    expect(execute).not.toHaveBeenCalled();
  });

  it('coalesces concurrent triggers into one single-flight dispatch', async () => {
    let release!: () => void;
    const dispatchProposal = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const loop = new DigitalEmployeeLoop({
      collectEnvironment: vi.fn().mockResolvedValue(environment()),
      calendar: { listDue: vi.fn().mockResolvedValue([]), execute: vi.fn() },
      selfWorkPolicy: { propose: vi.fn().mockResolvedValue(proposal) },
      dispatchProposal,
      maxDispatchesPerTrigger: 1,
    });

    const first = loop.trigger('burst_finished');
    const second = loop.trigger('dependency_resolved');
    await vi.waitFor(() => expect(dispatchProposal).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(dispatchProposal).toHaveBeenCalledOnce();
  });

  it('rejects a proposal that depends on an unresolved dependency', async () => {
    const dispatchProposal = vi.fn();
    const loop = new DigitalEmployeeLoop({
      collectEnvironment: vi.fn().mockResolvedValue({
        ...environment(),
        pendingDependencies: ['book-title'],
      }),
      calendar: { listDue: vi.fn().mockResolvedValue([]), execute: vi.fn() },
      selfWorkPolicy: {
        propose: vi.fn().mockResolvedValue({ ...proposal, blockedBy: ['book-title'] }),
      },
      dispatchProposal,
    });
    const result = await loop.trigger('burst_finished');
    expect(result.reason).toBe('dependency_unresolved');
    expect(dispatchProposal).not.toHaveBeenCalled();
  });
});
