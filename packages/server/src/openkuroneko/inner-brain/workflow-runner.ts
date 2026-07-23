/**
 * Execute-mode workflow runner — stepwise expect, no redesign.
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ExecutableWorkflow,
  WorkflowFailurePolicy,
  WorkflowStep,
  WorkflowStepExpect,
} from '../../outer/executable-workflow-types.js';
import { isRedesignAllowed } from '../../outer/burst-mode-gate.js';
import {
  runBrowserStepsAdapter,
  runFrozenDagAdapter,
  runKpiCharterAdapter,
  type RunBrowserStepsFn,
  type RunLocalDagFn,
} from './workflow-adapters.js';

export interface WorkflowStepResult {
  stepId: string;
  ok: boolean;
  attempts: number;
  detail?: string;
}

export interface WorkflowRunResult {
  workflowId: string;
  version: string;
  ok: boolean;
  steps: WorkflowStepResult[];
  abortedAt?: string;
  fallbackExplore?: boolean;
}

export interface WorkflowRunnerDeps {
  workDir: string;
  /** 注入 shell 执行（单测可 stub） */
  runShell?: (command: string, cwd: string) => { exitCode: number; stdout: string; stderr: string };
  /** 注入真实 browser 执行（缺省 dry-run；有注入且未 dryRun=true 则真跑） */
  runBrowserSteps?: RunBrowserStepsFn;
  /** 注入 frozen_dag 真跑（缺省只物化） */
  runLocalDag?: RunLocalDagFn;
  now?: () => string;
}

function defaultShell(command: string, cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

export function checkExpect(
  expect: WorkflowStepExpect,
  ctx: { workDir: string; exitCode?: number; stdout?: string },
): { ok: boolean; detail: string } {
  if (expect.exitCode !== undefined) {
    if (ctx.exitCode !== expect.exitCode) {
      return {
        ok: false,
        detail: `exitCode want ${expect.exitCode} got ${ctx.exitCode ?? 'n/a'}`,
      };
    }
  }
  if (expect.fileExists?.trim()) {
    const p = path.resolve(ctx.workDir, expect.fileExists.trim());
    if (!p.startsWith(path.resolve(ctx.workDir))) {
      return { ok: false, detail: `fileExists path escapes workDir: ${expect.fileExists}` };
    }
    if (!fs.existsSync(p)) {
      return { ok: false, detail: `file missing: ${expect.fileExists}` };
    }
  }
  if (expect.stdoutContains?.trim()) {
    const needle = expect.stdoutContains.trim();
    const hay = `${ctx.stdout ?? ''}`;
    if (!hay.includes(needle)) {
      return { ok: false, detail: `stdout missing: ${needle}` };
    }
  }
  return { ok: true, detail: 'ok' };
}

async function runOneStep(
  step: WorkflowStep,
  deps: WorkflowRunnerDeps,
): Promise<{ ok: boolean; detail: string; exitCode?: number; stdout?: string }> {
  const runShell = deps.runShell ?? defaultShell;
  switch (step.action) {
    case 'assert':
    case 'skill_step': {
      const touch = typeof step.args?.['touch'] === 'string' ? String(step.args['touch']) : '';
      if (touch) {
        const p = path.resolve(deps.workDir, touch);
        if (!p.startsWith(path.resolve(deps.workDir))) {
          return { ok: false, detail: 'touch escapes workDir' };
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '', 'utf8');
      }
      return { ok: true, detail: 'assert-ready', exitCode: 0, stdout: '' };
    }
    case 'shell': {
      const cmd = String(step.args?.['command'] ?? '').trim();
      if (!cmd) return { ok: false, detail: 'shell: args.command required' };
      const r = runShell(cmd, deps.workDir);
      return {
        ok: true,
        detail: r.stderr || `exit ${r.exitCode}`,
        exitCode: r.exitCode,
        stdout: r.stdout,
      };
    }
    case 'browser_steps': {
      const r = await runBrowserStepsAdapter(deps.workDir, step.args, {
        runBrowserSteps: deps.runBrowserSteps,
      });
      return {
        ok: r.ok,
        detail: r.detail,
        exitCode: r.exitCode ?? (r.ok ? 0 : 1),
        stdout: r.stdout ?? '',
      };
    }
    case 'run_node': {
      const r = await runFrozenDagAdapter(deps.workDir, step.args, {
        runLocalDag: deps.runLocalDag,
      });
      return {
        ok: r.ok,
        detail: r.detail,
        exitCode: r.exitCode ?? (r.ok ? 0 : 1),
        stdout: r.stdout ?? '',
      };
    }
    case 'kpi_charter': {
      const args = {
        ...(step.args ?? {}),
        outName:
          typeof step.args?.['outName'] === 'string' ? step.args['outName'] : step.id,
        outPath:
          typeof step.args?.['outPath'] === 'string'
            ? step.args['outPath']
            : `.run/kpi_sequence/${step.id}.md`,
      };
      const r = runKpiCharterAdapter(deps.workDir, args);
      return {
        ok: r.ok,
        detail: r.detail,
        exitCode: r.exitCode ?? (r.ok ? 0 : 1),
        stdout: r.stdout ?? '',
      };
    }
    default:
      return { ok: false, detail: `unknown action ${(step as WorkflowStep).action}` };
  }
}

/**
 * 逐步执行；失败按 failurePolicy。
 * execute 模式下调用方应先确认 isRedesignAllowed(mode)===false。
 */
export async function runExecutableWorkflow(
  wf: ExecutableWorkflow,
  deps: WorkflowRunnerDeps,
): Promise<WorkflowRunResult> {
  fs.mkdirSync(deps.workDir, { recursive: true });
  const policy: WorkflowFailurePolicy = wf.failurePolicy;
  const stepResults: WorkflowStepResult[] = [];

  for (const step of wf.steps) {
    let attempts = 0;
    let lastOk = false;
    let lastDetail = '';
    const maxAttempts = Math.max(1, policy.maxRetries + 1);

    while (attempts < maxAttempts) {
      attempts += 1;
      const ran = await runOneStep(step, deps);
      if (
        !ran.ok &&
        (step.action === 'browser_steps' ||
          step.action === 'run_node' ||
          step.action === 'kpi_charter' ||
          (step.action !== 'shell' &&
            step.action !== 'assert' &&
            step.action !== 'skill_step'))
      ) {
        lastOk = false;
        lastDetail = ran.detail;
      } else {
        const checked = checkExpect(step.expect, {
          workDir: deps.workDir,
          exitCode: ran.exitCode,
          stdout: ran.stdout,
        });
        lastOk = checked.ok;
        lastDetail = checked.ok ? ran.detail : checked.detail;
      }
      if (lastOk) break;
      if (policy.onStepFail !== 'retry_same') break;
    }

    stepResults.push({
      stepId: step.id,
      ok: lastOk,
      attempts,
      detail: lastDetail,
    });

    if (!lastOk) {
      const result: WorkflowRunResult = {
        workflowId: wf.id,
        version: wf.version,
        ok: false,
        steps: stepResults,
        abortedAt: step.id,
        fallbackExplore: policy.onStepFail === 'fallback_explore',
      };
      writeRunTrace(deps.workDir, result);
      return result;
    }
  }

  const result: WorkflowRunResult = {
    workflowId: wf.id,
    version: wf.version,
    ok: true,
    steps: stepResults,
  };
  writeRunTrace(deps.workDir, result);
  return result;
}

function writeRunTrace(workDir: string, result: WorkflowRunResult): void {
  const runDir = path.join(workDir, '.run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'workflow_run.json'), JSON.stringify(result, null, 2), 'utf8');
}

/** 供 Designer 门闩：execute 工作区标记 */
export interface BurstModeMarker {
  burstMode: 'explore' | 'execute';
  workflowRef?: { id: string; version: string };
}

export function writeBurstModeMarker(workDir: string, marker: BurstModeMarker): void {
  const brain = path.join(workDir, '.brain');
  fs.mkdirSync(brain, { recursive: true });
  fs.writeFileSync(path.join(brain, 'burst-mode.json'), JSON.stringify(marker, null, 2), 'utf8');
}

export function readBurstModeMarker(workDir: string): BurstModeMarker {
  const p = path.join(workDir, '.brain', 'burst-mode.json');
  if (!fs.existsSync(p)) return { burstMode: 'explore' };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as BurstModeMarker;
    return {
      burstMode: j.burstMode === 'execute' ? 'execute' : 'explore',
      workflowRef: j.workflowRef,
    };
  } catch {
    return { burstMode: 'explore' };
  }
}

export function assertDesignerMayRedesign(workDir: string): void {
  const m = readBurstModeMarker(workDir);
  if (!isRedesignAllowed(m.burstMode)) {
    throw new Error(
      `burstMode=execute：禁止 redesign / commit_local_dag（workflow ${m.workflowRef?.id ?? '?'}@${m.workflowRef?.version ?? '?'}）`,
    );
  }
}
