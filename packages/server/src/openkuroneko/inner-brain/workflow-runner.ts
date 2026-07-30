/**
 * Execute-mode workflow runner — stepwise expect, no redesign.
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md
 */
import { spawn } from 'node:child_process';
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
import {
  resolveStepSecrets,
  type ResolveSecretFn,
} from '../../outer/workflow-secret-resolve.js';
import { materializeWorkflowAssets } from '../../outer/workflow-assets.js';
import { hoistSecretRefs } from '../../outer/workflow-promote.js';

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

export type ShellRunResult = { exitCode: number; stdout: string; stderr: string };

export interface WorkflowRunnerDeps {
  workDir: string;
  /**
   * 注入 shell 执行（单测可 stub）。
   * 必须异步：默认同步 spawnSync 会卡住 Node 事件循环，导致外脑无法回消息。
   */
  runShell?: (
    command: string,
    cwd: string,
    env?: Record<string, string>,
  ) => ShellRunResult | Promise<ShellRunResult>;
  /** 注入真实 browser 执行（缺省 dry-run；有注入且未 dryRun=true 则真跑） */
  runBrowserSteps?: RunBrowserStepsFn;
  /** 注入 frozen_dag 真跑（缺省只物化） */
  runLocalDag?: RunLocalDagFn;
  /** W11：keychain 解析（缺省则有 secretRefs 时步骤失败） */
  resolveSecret?: ResolveSecretFn;
  now?: () => string;
}

/** 异步 shell，避免阻塞外脑 / health */
function defaultShell(
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: env && Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    const max = 2 * 1024 * 1024;
    child.stdout?.on('data', (buf: Buffer) => {
      if (stdout.length < max) stdout += buf.toString('utf8').slice(0, max - stdout.length);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      if (stderr.length < max) stderr += buf.toString('utf8').slice(0, max - stderr.length);
    });
    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: stderr || String(err) });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
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

  let secretEnv: Record<string, string> = {};
  let cookiesFileRel: string | undefined;
  if (step.secretRefs && Object.keys(step.secretRefs).length > 0) {
    if (!deps.resolveSecret) {
      return {
        ok: false,
        detail: 'secretRefs set but resolveSecret not configured (W11)',
      };
    }
    try {
      const resolved = await resolveStepSecrets(step, deps.workDir, deps.resolveSecret);
      secretEnv = resolved.env;
      cookiesFileRel = resolved.cookiesFileRel;
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

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
      const r = await Promise.resolve(runShell(cmd, deps.workDir, secretEnv));
      return {
        ok: true,
        detail: r.stderr || `exit ${r.exitCode}`,
        exitCode: r.exitCode,
        stdout: r.stdout,
      };
    }
    case 'browser_steps': {
      const args = { ...(step.args ?? {}) };
      if (cookiesFileRel && args['cookies_file'] == null && args['cookiesFile'] == null) {
        args['cookies_file'] = cookiesFileRel;
      }
      const r = await runBrowserStepsAdapter(deps.workDir, args, {
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
  try {
    materializeWorkflowAssets(wf.assets, deps.workDir);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const result: WorkflowRunResult = {
      workflowId: wf.id,
      version: wf.version,
      ok: false,
      steps: [{ stepId: '__assets__', ok: false, attempts: 1, detail }],
      abortedAt: '__assets__',
    };
    writeRunTrace(deps.workDir, result);
    return result;
  }

  const policy: WorkflowFailurePolicy = wf.failurePolicy;
  const stepResults: WorkflowStepResult[] = [];

  for (const rawStep of wf.steps) {
    const step = hoistSecretRefs(rawStep);
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
