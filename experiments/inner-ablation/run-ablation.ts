/**
 * 内脑消融运行器（INNER-ABLATION.md）：tasks × arms × repeats，每次运行一个隔离子进程。
 *
 *   # 冒烟（本地 fake LLM，不花 token）
 *   npx --yes tsx experiments/inner-ablation/run-ablation.ts --fake
 *   # 真实一轮（先 source LLM 配置）
 *   set -a; source deploy/agent/env/collatz-lean.env; set +a
 *   npx --yes tsx experiments/inner-ablation/run-ablation.ts --repeats=3 --concurrency=2
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARM_RESULT_FILE } from './arm-worker-paths.ts';
import { startFakeLlmServer, type FakeLlmServer } from './fake-llm-server.ts';
import { copyDir, freePort, hashFiles, killPortListeners } from './lib/fs-util.ts';
import { collectRunMetrics } from './lib/metrics.ts';
import { buildReport, renderMarkdown, type RunRecord } from './lib/report.ts';
import { BLOCKED_KILL_LOG, cleanupHostResidue, prepareSandboxBin } from './lib/sandbox.ts';
import { REAL_TASKS, ROUND1_TASKS, ROUND2_TASKS, ROUND3_TASKS, ROUND4_TASKS, SMOKE_TASKS, findTask } from './tasks/index.ts';
import { ARM_IDS, type AblationTask, type ArmId } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export interface AblationOptions {
  arms: ArmId[];
  tasks: AblationTask[];
  repeats: number;
  concurrency: number;
  fake: boolean;
  outDir: string;
  timeoutMs: number;
  maxTicks: number;
  maxRounds: number;
  /** 已有 result.json 的运行直接收进报告，不重跑 */
  resume?: boolean;
  log?: (line: string) => void;
}

const SCRUB_PREFIXES = ['DRIVE9_', 'MEM9_', 'INNER_', 'KPI_', 'ABLATION_'];
const SCRUB_KEYS = ['OPENKURONEKO_OB_SKILL_POOL', 'UTLRA_DATA_ROOT'];

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  run: { arm: ArmId; dataRoot: string; workDir: string; workspaceId: string; instanceId: string; maxTicks: number; maxRounds: number },
  fake: FakeLlmServer | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (SCRUB_KEYS.includes(k) || SCRUB_PREFIXES.some(p => k.startsWith(p))) continue;
    env[k] = v;
  }
  Object.assign(env, {
    UTLRA_DATA_ROOT: run.dataRoot,
    INNER_WORK_DIR: run.workDir,
    INNER_WORKSPACE_ID: run.workspaceId,
    INNER_INSTANCE_ID: run.instanceId,
    ABLATION_ARM: run.arm,
    ABLATION_MAX_TICKS: String(run.maxTicks),
  });
  if (run.arm === 'single') env['INNER_BASE_NODE_MAX_ROUNDS'] = String(run.maxRounds);
  if (fake) {
    Object.assign(env, {
      UTLRA_INNER_LLM_PROVIDER: 'zhipu',
      ZHIPU_API_KEY: 'fake-key',
      ZHIPU_BASE_URL: fake.baseUrl,
      ZHIPU_MODEL: 'fake-model',
      ZHIPU_THINKING: 'disabled',
    });
  }
  return env;
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch { /* group already gone */ }
}

async function runOne(
  task: AblationTask,
  arm: ArmId,
  rep: number,
  opts: AblationOptions,
  fake: FakeLlmServer | null,
  sandbox: { binDir: string; nodeBin: string },
): Promise<RunRecord> {
  const runDir = runDirOf(opts.outDir, task, arm, rep);
  const dataRoot = path.join(runDir, 'data');
  const workspaceId = `task-abl-${task.id}-${arm}-r${rep}`;
  const workDir = path.join(dataRoot, 'workspaces', workspaceId);
  const instanceId = `abl-${task.id}-${arm}-r${rep}`;
  fs.rmSync(runDir, { recursive: true, force: true });
  copyDir(task.fixtureDir, workDir);

  const params = { port: await freePort() };
  fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.brain', 'goal.md'), task.goal(params), 'utf8');
  const before = hashFiles(workDir, task.protectedFiles);

  const env = buildChildEnv(
    process.env,
    { arm, dataRoot, workDir, workspaceId, instanceId, maxTicks: opts.maxTicks, maxRounds: opts.maxRounds },
    fake,
  );
  env['PATH'] = `${sandbox.binDir}${path.delimiter}${env['PATH'] ?? ''}`;
  const logFd = fs.openSync(path.join(runDir, 'worker.log'), 'a');
  const started = Date.now();
  const child = spawn(sandbox.nodeBin, ['--import', 'tsx', path.join(here, 'arm-worker.ts')], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, opts.timeoutMs);
  const exitCode = await new Promise<number | null>(resolve => {
    child.on('exit', code => resolve(code));
    child.on('error', () => resolve(null));
  });
  clearTimeout(timer);
  const wallMs = Date.now() - started;
  // 会话结束 = 回收整个进程组（与生产 burst 结束一致）；真正脱离会话的进程才会留下
  killGroup(child.pid);
  await new Promise(r => setTimeout(r, 500));

  const after = hashFiles(workDir, task.protectedFiles);
  const tampered = task.protectedFiles.filter(rel => before[rel] !== after[rel]);
  let grade;
  try {
    grade = await task.grade(workDir, params);
  } catch (e) {
    grade = { pass: false, checks: [{ name: 'grader_crashed', ok: false, detail: String(e) }] };
  }
  if (tampered.length > 0) {
    grade = { pass: false, checks: [...grade.checks, { name: 'protected_files_intact', ok: false, detail: tampered.join(',') }] };
  }
  try {
    await task.cleanup?.(workDir, params);
  } catch { /* best effort */ }
  killPortListeners(params.port);
  const hostResidue = cleanupHostResidue(workDir);
  const blockedKillFile = path.join(workDir, BLOCKED_KILL_LOG);
  const blockedKills = fs.existsSync(blockedKillFile)
    ? fs.readFileSync(blockedKillFile, 'utf8').split('\n').filter(Boolean)
    : [];

  let armResult: unknown = null;
  try {
    armResult = JSON.parse(fs.readFileSync(path.join(workDir, ARM_RESULT_FILE), 'utf8'));
  } catch { /* worker crashed or timed out */ }

  const record: RunRecord = {
    taskId: task.id,
    arm,
    rep,
    workspaceId,
    runDir,
    exit: timedOut ? 'timeout' : exitCode === 0 ? 'ok' : 'error',
    exitCode,
    wallMs,
    tampered,
    hostResidue,
    blockedKills,
    grade,
    metrics: collectRunMetrics({ dataRoot, workspaceId, workDir }),
    armResult,
  };
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(record, null, 2));
  return record;
}

export const groupOf = (t: AblationTask) => t.exclusiveGroup ?? t.id;

export const runDirOf = (outDir: string, task: AblationTask, arm: ArmId, rep: number) =>
  path.join(outDir, task.id, arm, `r${rep}`);

/** 取第一个所在互斥组空闲的任务；全被占用返回 -1 */
export function pickNextJob(pending: readonly { task: AblationTask }[], busy: ReadonlySet<string>): number {
  return pending.findIndex(j => !busy.has(groupOf(j.task)));
}

export async function runAblation(opts: AblationOptions) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const drive9Config = path.join(os.homedir(), '.drive9', 'config');
  if (fs.existsSync(drive9Config)) {
    throw new Error(`${drive9Config} 存在：drive9 会被自动启用，跨运行污染。请先移走再跑。`);
  }
  if (!opts.fake && !process.env['ZHIPU_API_KEY'] && !process.env['OPENAI_API_KEY']) {
    throw new Error('缺 LLM 配置：先 source 一份含 ZHIPU_API_KEY 的 env，或用 --fake');
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const sandbox = prepareSandboxBin(opts.outDir);
  const fake = opts.fake ? await startFakeLlmServer() : null;
  const startedAt = new Date().toISOString();

  const runs: RunRecord[] = [];
  const pending: { task: AblationTask; arm: ArmId; rep: number }[] = [];
  for (let rep = 1; rep <= opts.repeats; rep++) {
    for (const task of opts.tasks) {
      for (const arm of opts.arms) {
        const done = path.join(runDirOf(opts.outDir, task, arm, rep), 'result.json');
        if (opts.resume && fs.existsSync(done)) {
          runs.push(JSON.parse(fs.readFileSync(done, 'utf8')) as RunRecord);
          continue;
        }
        pending.push({ task, arm, rep });
      }
    }
  }
  if (runs.length > 0) log(`[resume] kept ${runs.length} finished run(s), ${pending.length} to go`);
  const busy = new Set<string>();
  let wake: (() => void)[] = [];
  async function lane(): Promise<void> {
    while (pending.length > 0) {
      const idx = pickNextJob(pending, busy);
      if (idx < 0) {
        await new Promise<void>(r => wake.push(r));
        continue;
      }
      const job = pending.splice(idx, 1)[0]!;
      const group = groupOf(job.task);
      busy.add(group);
      log(`[start] ${job.task.id} / ${job.arm} / r${job.rep}`);
      try {
        const r = await runOne(job.task, job.arm, job.rep, opts, fake, sandbox);
        runs.push(r);
        log(
          `[done]  ${r.taskId} / ${r.arm} / r${r.rep}: ${r.grade.pass ? 'PASS' : 'FAIL'} ` +
            `exit=${r.exit} tokens=${r.metrics.totalTokens} tools=${r.metrics.toolCalls} ${(r.wallMs / 1000).toFixed(0)}s`,
        );
      } finally {
        busy.delete(group);
        const w = wake;
        wake = [];
        w.forEach(f => f());
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, lane));
  } finally {
    await fake?.close();
  }

  runs.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.arm.localeCompare(b.arm) || a.rep - b.rep);
  const report = buildReport(runs, { startedAt, finishedAt: new Date().toISOString(), repeats: opts.repeats, fake: opts.fake });
  fs.writeFileSync(path.join(opts.outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(opts.outDir, 'report.md'), renderMarkdown(report));
  return report;
}

function parseArgs(argv: string[]): AblationOptions {
  const flags = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags.set(m[1]!, m[2] ?? 'true');
  }
  const fake = flags.get('fake') === 'true';
  const list = (k: string) => flags.get(k)?.split(',').map(s => s.trim()).filter(Boolean);
  const arms = (list('arms') ?? [...ARM_IDS]) as ArmId[];
  for (const a of arms) if (!ARM_IDS.includes(a)) throw new Error(`unknown arm ${a}`);
  const round = flags.get('round');
  const tasks = list('tasks')?.map(findTask)
    ?? (fake ? [...SMOKE_TASKS]
      : round === '1' ? [...ROUND1_TASKS]
      : round === '2' ? [...ROUND2_TASKS]
      : round === '3' ? [...ROUND3_TASKS]
      : round === '4' ? [...ROUND4_TASKS]
      : [...REAL_TASKS]);
  if (round && !['1', '2', '3', '4'].includes(round)) throw new Error(`unknown round ${round}（可选 1、2、3 或 4）`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    arms,
    tasks,
    repeats: Number(flags.get('repeats') ?? (fake ? 1 : 3)),
    concurrency: Number(flags.get('concurrency') ?? 1),
    fake,
    outDir: path.resolve(flags.get('out') ?? path.join(here, 'runs', `${fake ? 'fake-' : ''}${stamp}`)),
    timeoutMs: Number(flags.get('timeout-min') ?? 25) * 60_000,
    maxTicks: Number(flags.get('max-ticks') ?? 60),
    maxRounds: Number(flags.get('max-rounds') ?? 150),
    resume: flags.get('resume') === 'true',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[ablation] out=${opts.outDir} arms=${opts.arms.join(',')} tasks=${opts.tasks.map(t => t.id).join(',')} repeats=${opts.repeats}`);
  runAblation(opts).then(
    r => {
      console.log(`[ablation] verdict=${r.verdict}`);
      for (const a of r.arms) console.log(`[ablation] ${a.arm}: ${a.passes}/${a.runs} pass, tokens/pass=${a.tokensPerPass ?? '—'}`);
      console.log(`[ablation] report: ${path.join(opts.outDir, 'report.md')}`);
    },
    e => {
      console.error('[ablation] fatal', e);
      process.exit(1);
    },
  );
}
