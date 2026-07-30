import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { promoteWorkflow } from './workflow-promote.js';
import { findWorkflowRefForKpi, kpiWorkflowTag, kpiWorkflowRoleTag } from './workflow-for-kpi.js';
import { ConservativeSelfWorkPolicy, validateSelfWorkProposal } from './self-work-policy.js';
import { createSelfWorkStrategy } from './self-work-strategies.js';
import type { SelfWorkContext } from './self-work-policy.js';

describe('workflow-for-kpi + SelfWork execute', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('findWorkflowRefForKpi by tag', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-kpi-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    promoteWorkflow(store, {
      id: 'ew-fanqie',
      kind: 'shell_pipeline',
      title: 'Fanqie',
      tags: [kpiWorkflowTag('kpi-1')],
      steps: [{ id: 'a', action: 'assert', args: { touch: 'x' }, expect: { fileExists: 'x' } }],
    });
    expect(findWorkflowRefForKpi(store, 'kpi-1')).toEqual({ id: 'ew-fanqie', version: '1' });
    expect(findWorkflowRefForKpi(store, 'other')).toBeNull();
  });

  it('W12：prefer role:primary/collect over repair', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-kpi-role-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const step = {
      id: 'a',
      action: 'assert' as const,
      args: { touch: 'x' },
      expect: { fileExists: 'x' },
    };
    promoteWorkflow(store, {
      id: 'ew-aaa-repair',
      kind: 'shell_pipeline',
      title: 'repair',
      tags: [kpiWorkflowTag('kpi-x'), kpiWorkflowRoleTag('repair')],
      steps: [step],
    });
    promoteWorkflow(store, {
      id: 'ew-zzz-collect',
      kind: 'shell_pipeline',
      title: 'collect',
      tags: [kpiWorkflowTag('kpi-x'), kpiWorkflowRoleTag('collect')],
      steps: [step],
    });
    expect(findWorkflowRefForKpi(store, 'kpi-x')?.id).toBe('ew-zzz-collect');
  });

  it('validate execute_missing_workflow_ref', () => {
    const ctx: SelfWorkContext = {
      activeKpis: [{ kpiId: 'k1', description: 'd', status: 'active', momentum: 1 }],
      pendingDependencies: [],
      runningConflicts: [],
      recentActions: [],
    };
    expect(
      validateSelfWorkProposal(
        {
          kpiId: 'k1',
          action: 'run',
          expectedOutcome: 'ok',
          reason: 'r',
          strategyId: 'conservative',
          burstMode: 'execute',
        },
        ctx,
      ).reason,
    ).toBe('execute_missing_workflow_ref');
  });

  it('AngleSelfWorkPolicy prefers execute when pickWorkflowRef hits', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-kpi-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    promoteWorkflow(store, {
      id: 'ew-k1',
      kind: 'shell_pipeline',
      title: 'K1',
      tags: ['kpi:k1'],
      steps: [{ id: 'a', action: 'assert', args: { touch: 'x' }, expect: { fileExists: 'x' } }],
    });
    const policy = createSelfWorkStrategy('conservative');
    const proposal = await policy.propose({
      activeKpis: [{ kpiId: 'k1', description: 'desc', status: 'active', momentum: 2 }],
      pendingDependencies: [],
      runningConflicts: [],
      recentActions: [],
      pickWorkflowRef: (id) => findWorkflowRefForKpi(store, id),
    });
    expect(proposal?.burstMode).toBe('execute');
    expect(proposal?.workflowRef).toEqual({ id: 'ew-k1', version: '1' });
  });

  it('ConservativeSelfWorkPolicy same prefer', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-kpi-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    promoteWorkflow(store, {
      id: 'ew-k2',
      kind: 'shell_pipeline',
      title: 'K2',
      tags: ['kpi:k2'],
      steps: [{ id: 'a', action: 'assert', args: { touch: 'x' }, expect: { fileExists: 'x' } }],
    });
    const proposal = await new ConservativeSelfWorkPolicy().propose({
      activeKpis: [{ kpiId: 'k2', description: 'd', status: 'active', momentum: 1 }],
      pendingDependencies: [],
      runningConflicts: [],
      recentActions: [],
      pickWorkflowRef: (id) => findWorkflowRefForKpi(store, id),
    });
    expect(proposal?.workflowRef?.id).toBe('ew-k2');
  });
});
