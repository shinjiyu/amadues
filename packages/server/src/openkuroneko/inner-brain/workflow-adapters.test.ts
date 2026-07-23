import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBrowserStepsAdapter, runFrozenDagAdapter, runKpiCharterAdapter } from './workflow-adapters.js';
import { readLocalDag } from './local-dag-store.js';
import { runExecutableWorkflow } from './workflow-runner.js';
import type { ExecutableWorkflow } from '../../outer/executable-workflow-types.js';

describe('workflow-adapters', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('browser_steps dry-run 校验并落盘', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-adap-'));
    const r = await runBrowserStepsAdapter(workDir, {
      steps: [{ action: 'goto', url: 'https://example.com' }, { action: 'snapshot' }],
    });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.run', 'playbook-prepared.json'))).toBe(true);
    expect(r.stdout).toContain('playbook_steps=2');
  });

  it('browser_steps 拒收非法 action', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-adap-'));
    const r = await runBrowserStepsAdapter(workDir, {
      steps: [{ action: 'hack' }],
    });
    expect(r.ok).toBe(false);
  });

  it('browser_steps 注入真跑', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-adap-'));
    let called = 0;
    const r = await runBrowserStepsAdapter(
      workDir,
      { steps: [{ action: 'goto', url: 'https://example.com' }] },
      {
        runBrowserSteps: async (steps) => {
          called = steps.length;
          return { ok: true, detail: 'live', exitCode: 0, stdout: 'live_ok' };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(called).toBe(1);
    expect(r.stdout).toBe('live_ok');
  });

  it('frozen_dag 物化 local_dag', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-adap-'));
    const r = await runFrozenDagAdapter(workDir, {
      dag: {
        nodes: [
          { id: 'n1', ref: 'preset/base', instruction: 'do' },
          { id: 'n2', ref: 'local/x' },
        ],
      },
    });
    expect(r.ok).toBe(true);
    const dag = readLocalDag(workDir);
    expect(dag?.nodes).toHaveLength(2);
    expect(fs.existsSync(path.join(workDir, '.run', 'frozen_dag_ready.json'))).toBe(true);
  });

  it('frozen_dag 注入 runLocalDag', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-adap-'));
    let called = 0;
    const r = await runFrozenDagAdapter(
      workDir,
      { dag: { nodes: [{ id: 'n1', ref: 'preset/base' }] } },
      {
        runLocalDag: async (dag) => {
          called = dag.nodes.length;
          return { ok: true, detail: 'ran', exitCode: 0, stdout: 'dag_live' };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(called).toBe(1);
    expect(r.stdout).toBe('dag_live');
  });

  it('runner 集成 browser + frozen', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-adap-'));
    const wf: ExecutableWorkflow = {
      id: 'ew-mix',
      version: '1',
      kind: 'browser_playbook',
      title: 'mix',
      tags: [],
      entry: 'b',
      steps: [
        {
          id: 'b',
          action: 'browser_steps',
          args: { steps: [{ action: 'goto', url: 'https://x.test' }] },
          expect: { fileExists: '.run/playbook-prepared.json' },
        },
        {
          id: 'd',
          action: 'run_node',
          args: { dag: { nodes: [{ id: 'n1', ref: 'preset/base' }] } },
          expect: { fileExists: '.run/frozen_dag_ready.json', stdoutContains: 'frozen_nodes=1' },
        },
      ],
      failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 0 },
      source: { promotedAt: '2026-07-23T00:00:00.000Z' },
    };
    const run = await runExecutableWorkflow(wf, { workDir });
    expect(run.ok).toBe(true);
  });

  it('kpi_sequence：kpi_charter 物化 + runner', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-kpi-seq-'));
    const r = runKpiCharterAdapter(workDir, {
      charter: '写一篇短文并落盘',
      outPath: '.run/kpi_sequence/s1.md',
    });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(workDir, '.run', 'kpi_sequence', 's1.md'), 'utf8')).toContain('短文');

    const wf: ExecutableWorkflow = {
      id: 'ew-seq',
      version: '1',
      kind: 'kpi_sequence',
      title: 'seq',
      tags: [],
      entry: 'c1',
      steps: [
        {
          id: 'c1',
          action: 'kpi_charter',
          args: { charter: '第一步：收集素材' },
          expect: { fileExists: '.run/kpi_sequence/c1.md', stdoutContains: 'kpi_charter=' },
        },
        {
          id: 'c2',
          action: 'kpi_charter',
          args: { charter: '第二步：成稿' },
          expect: { fileExists: '.run/kpi_sequence/c2.md' },
        },
      ],
      failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 0 },
      source: { promotedAt: '2026-07-23T00:00:00.000Z' },
    };
    const run = await runExecutableWorkflow(wf, { workDir });
    expect(run.ok).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.run', 'kpi_sequence', 'c2.md'))).toBe(true);
  });
});
