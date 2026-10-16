/**
 * DeepSWE 原题 × 本仓库 shell 循环（ADL: TOOL-MDL-GROWTH.md §11.23）
 *
 * 只用 instruction.md 和 task.toml 里的仓库 / base commit。
 * 不跑 Pier，不把 solution/ 放进工作区，不改 min-gain。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/minimal-react-mdl/run-deepswe.ts
 *   npx --yes tsx experiments/minimal-react-mdl/run-deepswe.ts --n=4 --budget=30
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTrace, type TraceRecord } from '../../packages/server/src/openkuroneko/tool-mdl/action-log.ts';
import { runGrowthCycle, type AntiUnifyResult } from '../../packages/server/src/openkuroneko/tool-mdl/growth-cycle.ts';
import { runReactKernel } from '../../packages/server/src/openkuroneko/tool-mdl/react-kernel.ts';
import { loadLibrary } from '../../packages/server/src/openkuroneko/tool-mdl/tool-library.ts';
import {
  artifactEffectDigest,
  buildFixturesFromOriginal,
} from '../../packages/server/src/openkuroneko/tool-mdl/tool-replay-gate.ts';
import { mineCandidates } from '../../packages/server/src/openkuroneko/tool-mdl/trace-miner.ts';
import type { ToolCandidate } from '../../packages/server/src/openkuroneko/tool-mdl/trace-miner.ts';
import {
  firstJsonObject,
  makeShellExecutor,
  zhipuChat,
  type LlmUsage,
} from './ports.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheRoot = path.join(here, '.cache-deepswe');
const workRoot = path.join(here, '.run-deepswe', 'work');

const BENCH_URL = 'https://github.com/datacurve-ai/deep-swe.git';

interface SweTask {
  id: string;
  repoUrl: string;
  commit: string;
  instruction: string;
  cachePath: string;
}

function argNum(name: string, fallback: number): number {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts?.cwd,
    encoding: 'utf8',
    timeout: opts?.timeout ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function must(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): void {
  const r = run(cmd, args, opts);
  if (!r.ok) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.out.slice(-1500)}`);
}

function tomlValue(text: string, key: string): string {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m?.[1] ?? '';
}

function ensureBenchmark(): string {
  const dest = path.join(cacheRoot, 'deep-swe');
  if (!fs.existsSync(path.join(dest, 'tasks'))) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    must('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', BENCH_URL, dest]);
    must('git', ['-C', dest, 'sparse-checkout', 'set', '--no-cone', 'tasks/*/task.toml', 'tasks/*/instruction.md']);
    must('git', ['-C', dest, 'checkout']);
  }
  return dest;
}

function selectTasks(bench: string, n: number, only?: string): Array<Omit<SweTask, 'cachePath'>> {
  const tasksDir = path.join(bench, 'tasks');
  const ids = fs
    .readdirSync(tasksDir)
    .filter(name => fs.existsSync(path.join(tasksDir, name, 'task.toml')))
    .sort();
  const python: Array<Omit<SweTask, 'cachePath'>> = [];
  for (const id of ids) {
    if (only && id !== only) continue;
    const toml = fs.readFileSync(path.join(tasksDir, id, 'task.toml'), 'utf8');
    if (!only && tomlValue(toml, 'language') !== 'python') continue;
    const repoUrl = tomlValue(toml, 'repository_url');
    const commit = tomlValue(toml, 'base_commit_hash');
    const instruction = fs.readFileSync(path.join(tasksDir, id, 'instruction.md'), 'utf8').trim();
    if (!repoUrl || !commit || !instruction) continue;
    python.push({ id, repoUrl, commit, instruction });
    if (python.length >= n) break;
  }
  return python;
}

function ensureCheckout(task: Omit<SweTask, 'cachePath'>): string {
  const dest = path.join(cacheRoot, 'repos', task.id);
  if (!fs.existsSync(path.join(dest, '.git'))) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    must('git', ['init', dest]);
    must('git', ['-C', dest, 'remote', 'add', 'origin', task.repoUrl]);
    must('git', ['-C', dest, 'fetch', '--depth', '1', 'origin', task.commit], { timeout: 600_000 });
    must('git', ['-C', dest, 'checkout', '--force', 'FETCH_HEAD']);
  }
  return dest;
}

function placeRepo(task: SweTask): void {
  const dest = path.join(workRoot, 'repos', task.id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  must('git', ['clone', '--local', task.cachePath, dest]);
  must('git', ['-C', dest, 'checkout', '--force', task.commit]);
  must('git', ['-C', dest, 'clean', '-fd']);
  must('git', ['-C', dest, 'config', 'user.email', 'agent@local']);
  must('git', ['-C', dest, 'config', 'user.name', 'agent']);
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 每条命令都从仓库根开始。只退回纯注释 / 占位常量，不按步数掐断读文件。 */
function makeRepoExecutor(repoCwd: string, baseCommit: string) {
  const raw = makeShellExecutor(repoCwd, { timeoutMs: 120_000 });
  return async (call: { name: string; args: Record<string, unknown> }) => {
    if (call.name !== 'shell_exec') return raw(call);
    const command = String(call.args.command ?? '');
    const wrapped = `cd ${q(repoCwd)} && { ${command}\n}`;
    const res = await raw({ name: 'shell_exec', args: { command: wrapped } });
    const added = countChanges(repoCwd, baseCommit);
    if (added.any > 0 && added.code === 0) {
      run('git', ['-C', repoCwd, 'reset', '--hard', baseCommit], { timeout: 30_000 });
      run('git', ['-C', repoCwd, 'clean', '-fd'], { timeout: 30_000 });
      res.ok = false;
      res.observation =
        'REVERTED: a comment or placeholder constant is not the feature. Edit the implementation, then git add and git commit.';
    }
    console.log(`    $ ${command.slice(0, 220)}`);
    console.log(`      -> ${res.ok ? 'ok' : 'fail'} ${res.observation.slice(0, 180).replace(/\n/g, ' ')}`);
    return res;
  };
}

function countChanges(repoCwd: string, baseCommit: string): { any: number; code: number } {
  const diff = run('git', ['-C', repoCwd, 'diff', '-U0', baseCommit], { timeout: 30_000 }).out;
  const untracked = run('git', ['-C', repoCwd, 'ls-files', '--others', '--exclude-standard'], {
    timeout: 30_000,
  }).out;
  let any = 0;
  let code = 0;
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1).trim();
    if (!body) continue;
    any += 1;
    if (body.startsWith('#')) continue;
    if (/^[A-Z][A-Z0-9_]* = \d+$/.test(body)) continue;
    code += 1;
  }
  for (const rel of untracked.split('\n')) {
    if (!rel || !/\.(py|pyi)$/.test(rel)) continue;
    const file = path.join(repoCwd, rel);
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
      const body = rawLine.trim();
      if (!body || body.startsWith('#')) continue;
      if (/^[A-Z][A-Z0-9_]* = \d+$/.test(body)) continue;
      any += 1;
      code += 1;
    }
  }
  return { any, code };
}

function materialize(task: SweTask): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepswe-replay-'));
  const dest = path.join(root, 'repos', task.id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const cloned = run('git', ['clone', '--local', task.cachePath, dest]);
  if (!cloned.ok) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(cloned.out.slice(-500));
  }
  run('git', ['-C', dest, 'checkout', '--force', task.commit]);
  run('git', ['-C', dest, 'clean', '-fd']);
  return root;
}

function diffDigest(root: string, task: SweTask): string | null {
  const r = run('git', ['-C', path.join(root, 'repos', task.id), 'diff', '--binary', task.commit], {
    timeout: 60_000,
  });
  if (!r.out.trim()) return null;
  return artifactEffectDigest(r.out, 'git.diff');
}

function taskOfRun(tasks: SweTask[], runId: string): SweTask | undefined {
  return tasks.find(t => t.id === runId);
}

function makeGitAntiUnify(tasks: SweTask[], usage: LlmUsage) {
  const system = [
    'You generalise a recurring shell subsequence into ONE reusable tool.',
    'Return ONE JSON object with keys: name, description (<=20 words), args, body, bindings.',
    'args: {"<arg>":{"type":"string","required":true}}.',
    'body: a bash script; it reads a JSON object of args on stdin. jq may be absent.',
    'bindings: one object per instance, in order, keys matching args.',
    'The gate compares a git diff digest, artifact=git.diff sha=..., against the base commit.',
    'cwd is the repository root. Reproduce that diff; do not print the repo.',
  ].join('\n');

  return async (cand: ToolCandidate, backing: TraceRecord[][]): Promise<AntiUnifyResult | null> => {
    const instances = backing.slice(0, 4);
    const effects = instances.map(steps => {
      const task = taskOfRun(tasks, steps[0]?.runId ?? '');
      if (!task) return null;
      const root = materialize(task);
      try {
        for (const step of steps) {
          const command = String(step.args.command ?? '');
          if (!command) continue;
          run('bash', ['-lc', command], { cwd: path.join(root, 'repos', task.id), timeout: 120_000 });
        }
        return diffDigest(root, task);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    const samples = instances.map((steps, i) =>
      [`# instance ${i}`, ...steps.map(s => `${s.symbol}: ${JSON.stringify(s.args)}`)].join('\n'),
    );
    const user = [
      `Recurring symbols: ${cand.symbols.join(' → ')}  (support=${cand.support})`,
      '',
      samples.join('\n\n'),
      '',
      'Expected effect digest of each instance:',
      ...effects.map((e, i) => `# instance ${i}: ${e ?? '(no diff; nothing to verify)'}`),
    ].join('\n');

    const obj = firstJsonObject(await zhipuChat(system, user, usage, 2400));
    if (!obj?.name || !obj?.body) return null;
    const bindings = Array.isArray(obj.bindings) ? (obj.bindings as Record<string, unknown>[]) : [];
    if (bindings.length === 0) return null;
    const bound = bindings.slice(0, instances.length).map((b, i) => ({
      ...b,
      repo: instances[i]?.[0]?.runId ?? '',
    }));
    const fixtures = await buildFixturesFromOriginal({
      bindings: bound,
      originalEffect: async i => effects[i],
    });
    if (fixtures.length === 0) return null;
    const manifest = {
      name: String(obj.name),
      description: String(obj.description ?? cand.symbols.join(' then ')),
      args: (obj.args ?? {}) as AntiUnifyResult['manifest']['args'],
      deps: [],
      kind: 'composition' as const,
      createdAt: new Date().toISOString(),
      minedFrom: { symbols: cand.symbols, support: cand.support },
    };
    const body = String(obj.body);
    const dir = path.join(workRoot, 'tools', manifest.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run'), body, { encoding: 'utf8', mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.proposal.json'), JSON.stringify({ manifest, fixtures }, null, 2));
    return { manifest, body, fixtures };
  };
}

function rejectFinish(message: string) {
  return {
    thought: 'not done',
    done: false as const,
    call: { name: 'shell_exec', args: { command: `printf '%s\\n' ${q(message)}` } },
  };
}

function salvageCommand(text: string): string | null {
  const diff = text.match(/```diff\s*\n([\s\S]*?)```/);
  if (diff?.[1] && (diff[1].includes('\n@@') || diff[1].includes('diff --git'))) {
    const body = diff[1].endsWith('\n') ? diff[1] : `${diff[1]}\n`;
    return `git apply --whitespace=nowarn <<'AGENT_DIFF'\n${body}AGENT_DIFF`;
  }
  const fence = text.match(/```(?:bash|sh|shell)\s*\n([\s\S]*?)```/);
  const body = fence?.[1]?.trim();
  if (!body) return null;
  if (/^(def |class |import |from )/.test(body)) return null;
  if (!/^[A-Za-z0-9./~_]/.test(body)) return null;
  return body;
}

function makeSweLlm(usage: LlmUsage) {
  const system = [
    'You are a software engineer solving one repository task in a POSIX shell.',
    'Reply with ONE JSON object and nothing else.',
    'To act: {"thought":"...","action":{"name":"shell_exec","args":{"command":"..."}}}',
    'To use a learned tool: {"thought":"...","action":{"name":"<tool>","args":{...}}}',
    'To finish: {"thought":"...","done":true,"answer":"..."}',
    'Every command starts at the repository root. cd does not persist.',
    'To edit, send a ```diff fence (unified diff). It is applied at the repository root.',
    'A comment or a placeholder constant is reverted. Implement the requested behavior.',
    'HEAD is detached: after the diff applies, git add and git commit on a new branch.',
    'The interpreter is python3, not python.',
    'Finish is rejected until that commit exists.',
    'A ```bash fence is also accepted. Do not wrap prose in a fence.',
    'If a learned tool matches the job, call it instead of repeating the same commands.',
  ].join('\n');
  return async (prompt: string) => {
    let text = '';
    try {
      text = await zhipuChat(system, prompt, usage, 8000);
    } catch (e) {
      return rejectFinish(`INVALID ACTION: ${(e as Error).message}. Reply with one shell_exec JSON object.`);
    }
    const obj = firstJsonObject(text);
    if (!obj) {
      const command = salvageCommand(text);
      if (command) {
        console.log('    [salvage] bash fence');
        return { thought: 'salvage', done: false, call: { name: 'shell_exec', args: { command } } };
      }
      console.log(`    [invalid-json] ${text.slice(0, 180).replace(/\n/g, ' ')}`);
      return rejectFinish('INVALID ACTION: reply was not JSON. Send one shell_exec, or a bash fence.');
    }
    if (obj.done === true) {
      return { thought: String(obj.thought ?? ''), done: true, answer: String(obj.answer ?? '') };
    }
    const action = obj.action as { name?: string; args?: Record<string, unknown> } | undefined;
    if (!action?.name) return rejectFinish('INVALID ACTION: JSON needs action.name. Send one shell_exec.');
    return { thought: String(obj.thought ?? ''), done: false, call: { name: action.name, args: action.args ?? {} } };
  };
}

function makeGitRunner(tasks: SweTask[]) {
  return async (name: string, args: Record<string, unknown>) => {
    const blob = JSON.stringify(args);
    const task = tasks.find(t => blob.includes(t.id));
    if (!task) return { ok: false, output: 'no task id in args' };
    const root = materialize(task);
    try {
      const bin = path.join(workRoot, 'tools', name, 'run');
      const r = spawnSync(bin, {
        cwd: path.join(root, 'repos', task.id),
        input: blob,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (r.status !== 0) return { ok: false, output: `exit=${r.status} ${(r.stderr ?? '').slice(0, 300)}` };
      return { ok: true, output: diffDigest(root, task) ?? '' };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function runBatch(
  tasks: SweTask[],
  budget: number,
  usage: LlmUsage,
): Promise<{ steps: number; traces: TraceRecord[] }> {
  const baseLlm = makeSweLlm(usage);
  let steps = 0;
  for (const task of tasks) {
    placeRepo(task);
    const repoCwd = path.join(workRoot, 'repos', task.id);
    const llm = async (prompt: string) => {
      const reply = await baseLlm(prompt);
      if (!reply.done) return reply;
      const atFinish = countChanges(repoCwd, task.commit);
      if (atFinish.code >= 8) return reply;
      const dirty = run('git', ['status', '--porcelain'], { cwd: repoCwd, timeout: 30_000 }).out.trim();
      const message =
        atFinish.any > 0 || dirty
          ? 'FINISH REJECTED: the current edit does not implement the feature. Apply a real diff and git commit.'
          : 'FINISH REJECTED: no source change since the base commit. Apply a diff and git commit. Do not finish.';
      console.log(`    [reject-finish] ${dirty ? 'dirty' : 'clean'}`);
      return rejectFinish(message);
    };
    const executor = makeRepoExecutor(repoCwd, task.commit);
    console.log(`\n[task ${task.id}]`);
    try {
      const res = await runReactKernel({
        workDir: workRoot,
        runId: task.id,
        task: task.instruction,
        llm,
        executor,
        budgetSteps: budget,
        maxObservationChars: 4_000,
        maxHistorySteps: 8,
        offerFinish: false,
        inlineCreateTool: false,
        announceObservationLimit: true,
      });
      steps += res.steps;
      const committed = run('git', ['log', '--oneline', `${task.commit}..HEAD`], { cwd: repoCwd, timeout: 30_000 });
      const stat = run('git', ['diff', '--stat', task.commit], { cwd: repoCwd, timeout: 30_000 });
      console.log(`  steps=${res.steps} stop=${res.stopReason}`);
      console.log(`  commits:\n${committed.out || '  (none)'}`);
      console.log(`  diff stat:\n${stat.out || '  (clean)'}`);
    } catch (e) {
      console.log(`  kernel error: ${(e as Error).message}`);
    }
  }
  const traces = tasks.flatMap(t => readTrace(workRoot, t.id)).filter(t => {
    const command = String(t.args.command ?? '');
    return !command.includes('FINISH REJECTED') && !command.includes('INVALID ACTION');
  });
  return { steps, traces };
}

async function main(): Promise<void> {
  const n = argNum('n', 4);
  const budget = argNum('budget', 30);
  const minGain = argNum('min-gain', 12);
  const only = process.argv.find(a => a.startsWith('--task='))?.split('=').slice(1).join('=');

  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(workRoot, 'repos'), { recursive: true });

  console.log('[deepswe] fetching task list');
  const bench = ensureBenchmark();
  const picked = selectTasks(bench, n, only);
  if (picked.length === 0) throw new Error('no python DeepSWE tasks found');
  console.log(`[deepswe] ${picked.length} tasks: ${picked.map(t => t.id).join(', ')}`);

  const tasks: SweTask[] = [];
  for (const t of picked) {
    console.log(`[deepswe] checkout ${t.id} ${t.repoUrl} @ ${t.commit.slice(0, 10)}`);
    tasks.push({ ...t, cachePath: ensureCheckout(t) });
  }

  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const first = await runBatch(tasks, budget, usage);
  const byRun = new Map<string, string[]>();
  for (const t of first.traces) {
    const xs = byRun.get(t.runId) ?? [];
    xs.push(`${t.symbol}${t.ok ? '' : '!'}`);
    byRun.set(t.runId, xs);
  }
  console.log('\n[traces]');
  for (const [id, xs] of byRun) console.log(`  ${id}: ${xs.join('→')}`);

  const minSupport = Math.max(2, Math.floor(tasks.length / 2));
  const near = mineCandidates(first.traces, { minSupport, minGain: 1 }).slice(0, 8);
  console.log('\n[motifs support>=' + minSupport + ', ignoring min-gain]');
  if (near.length === 0) console.log('  (none)');
  for (const c of near) {
    console.log(`  ${c.symbols.join('→')} support=${c.support} gain=${c.gain}${c.gain >= minGain ? '  PASS' : ''}`);
  }

  const growth = await runGrowthCycle(
    {
      workDir: workRoot,
      traces: first.traces,
      minSupport,
      minGain,
      remainingSteps: Math.max(1, first.steps),
      maxAcceptPerCycle: 1,
    },
    { antiUnify: makeGitAntiUnify(tasks, usage), runTool: makeGitRunner(tasks) },
  );
  console.log(
    `\n[growth] cands=${growth.candidates}` +
      ` accepted=[${growth.accepted.map(a => `${a.name}(ΔL=${a.deltaL})`).join(', ')}]` +
      ` rejected=[${growth.rejected.map(x => `${x.name}:${x.reason}`).join(', ')}]`,
  );

  let toolCalls = 0;
  if (growth.accepted.length > 0) {
    console.log('\n[second pass] same tasks, library visible');
    fs.rmSync(path.join(workRoot, 'runs'), { recursive: true, force: true });
    const second = await runBatch(tasks, budget, usage);
    const names = new Set(loadLibrary(workRoot).map(t => t.name));
    toolCalls = second.traces.filter(r => names.has(r.symbol)).length;
    console.log(`[second pass] toolCalls=${toolCalls}`);
  }

  const library = loadLibrary(workRoot).map(t => t.name);
  console.log(
    `\n[result] tasks=${tasks.length} budget=${budget} library=[${library.join(', ') || '空'}]` +
      ` toolCalls=${toolCalls} llmCalls=${usage.calls}` +
      ` promptTokens=${usage.promptTokens}`,
  );
  fs.writeFileSync(
    path.join(here, '.run-deepswe', 'report.json'),
    JSON.stringify(
      {
        tasks: tasks.map(t => t.id),
        budget,
        minGain,
        motifs: near,
        growth,
        library,
        toolCalls,
        usage,
      },
      null,
      2,
    ),
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
