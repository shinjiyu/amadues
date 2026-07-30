import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AdvancePerception } from './advance-perception.js';
import {
  considerWorkflowEvolution,
  evolutionToSelfWorkProposal,
  WorkflowEvolutionSelfWorkPolicy,
} from './workflow-evolution-policy.js';
import { listEvolutionProposals } from './workflow-evolution-store.js';
import { validateSelfWorkProposal, type SelfWorkPolicy } from './self-work-policy.js';

function emptyPerception(overrides: Partial<AdvancePerception> = {}): AdvancePerception {
  return {
    kpiIdsWithHealthyRunning: [],
    kpiIdsWithUnhealthyRunning: [],
    kpiIdsWithInFlight: [],
    kpiIdsWithFuturePeriodicCalendar: [],
    kpiIdsBootstrapDone: [],
    kpiIdsWithRecentStall: [],
    kpiIdsNeedingRepair: [],
    sinceAtByKpi: {},
    innerByKpi: {},
    calendarByKpi: {},
    stallByKpi: {},
    stallByInstance: {},
    ...overrides,
  };
}

describe('workflow evolution (W15)', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('considerWorkflowEvolution records pending on failed run', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-evo-'));
    const workDir = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(workDir, '.run'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.run', 'workflow_run.json'),
      JSON.stringify({
        workflowId: 'ew-twitter-collect-17-bloggers',
        version: '2',
        ok: false,
        steps: [{ stepId: 'collect_all', ok: false, detail: 'exit 2' }],
      }),
      'utf8',
    );

    const p = considerWorkflowEvolution({
      dataRoot: tmp,
      workDir,
      instanceId: 'ib-1',
      kpiId: 'kpi-mrulwvci-2896',
      workflowId: 'ew-twitter-collect-17-bloggers',
      version: '2',
    });
    expect(p?.status).toBe('pending');
    expect(listEvolutionProposals(tmp, 'pending')).toHaveLength(1);

    // dedup
    const p2 = considerWorkflowEvolution({
      dataRoot: tmp,
      workDir,
      kpiId: 'kpi-mrulwvci-2896',
      workflowId: 'ew-twitter-collect-17-bloggers',
      version: '2',
    });
    expect(p2?.id).toBe(p?.id);
    expect(listEvolutionProposals(tmp, 'pending')).toHaveLength(1);
  });

  it('ew_revision proposal bypasses future calendar gate', () => {
    const perception = {
      ...emptyPerception(),
      kpiIdsWithFuturePeriodicCalendar: ['kpi-1'],
      kpiIdsBootstrapDone: ['kpi-1'],
    };
    const proposal = evolutionToSelfWorkProposal({
      id: 'evo-1',
      workflowId: 'ew-x',
      version: '1',
      kpiId: 'kpi-1',
      signature: 'no_registered_deliverables',
      reasons: ['no_registered_deliverables'],
      charter: '【EW 修订】fix me',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })!;
    const ok = validateSelfWorkProposal(proposal, {
      activeKpis: [{ kpiId: 'kpi-1', description: 'x', status: 'active', notes: '', charter: '', momentum: 1 }],
      pendingDependencies: [],
      runningConflicts: [],
      recentActions: [],
      perception,
    });
    expect(ok).toEqual({ ok: true, reason: 'proposal_valid' });

    const collectBlocked = validateSelfWorkProposal(
      {
        kpiId: 'kpi-1',
        action: 'execute collect',
        expectedOutcome: 'ok',
        reason: 'known_executable_workflow',
        strategyId: 'conservative',
        burstMode: 'execute',
        workflowRef: { id: 'ew-x', version: '1' },
      },
      {
        activeKpis: [{ kpiId: 'kpi-1', description: 'x', status: 'active', notes: '', charter: '', momentum: 1 }],
        pendingDependencies: [],
        runningConflicts: [],
        recentActions: [],
        perception,
      },
    );
    expect(collectBlocked.ok).toBe(false);
    expect(collectBlocked.reason).toBe('kpi_has_scheduled_calendar');
  });

  it('WorkflowEvolutionSelfWorkPolicy prefers pending revision', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-evo-pol-'));
    const workDir = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(workDir, '.run'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.run', 'workflow_run.json'),
      JSON.stringify({ workflowId: 'ew-x', version: '1', ok: false, steps: [] }),
      'utf8',
    );
    considerWorkflowEvolution({
      dataRoot: tmp,
      workDir,
      kpiId: 'kpi-1',
      workflowId: 'ew-x',
      version: '1',
    });

    const inner: SelfWorkPolicy = {
      async propose() {
        return {
          kpiId: 'kpi-1',
          action: 'should not win',
          expectedOutcome: 'x',
          reason: 'inner',
          strategyId: 'conservative',
        };
      },
    };
    const wrapped = new WorkflowEvolutionSelfWorkPolicy(tmp, inner);
    const perception = {
      ...emptyPerception(),
      kpiIdsWithFuturePeriodicCalendar: ['kpi-1'],
    };
    const got = await wrapped.propose({
      activeKpis: [{ kpiId: 'kpi-1', description: 'x', status: 'active', notes: '', charter: '', momentum: 1 }],
      pendingDependencies: [],
      runningConflicts: [],
      recentActions: [],
      perception,
    });
    expect(got?.purpose).toBe('ew_revision');
    expect(got?.strategyId).toBe('workflow_evolution');
    expect(got?.action).toContain('EW 修订');
  });
});
