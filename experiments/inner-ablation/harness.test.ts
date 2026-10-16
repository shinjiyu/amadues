/**
 * 消融运行器自测：环境清洗、指标解析、判读规则、fake LLM 端到端冒烟（两臂都要跑通 fake-hello）。
 * 运行：npx --yes tsx --test experiments/inner-ablation/harness.test.ts
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { collectRunMetrics } from './lib/metrics.ts';
import { buildReport, type RunRecord } from './lib/report.ts';
import { BLOCKED_KILL_LOG, cleanupHostResidue, prepareSandboxBin } from './lib/sandbox.ts';
import { buildChildEnv, pickNextJob, runAblation } from './run-ablation.ts';
import { SMOKE_TASKS } from './tasks/index.ts';
import type { ArmId } from './types.ts';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ablation-harness-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function fakeRun(arm: ArmId, taskId: string, rep: number, pass: boolean, tokens: number): RunRecord {
  return {
    taskId,
    arm,
    rep,
    workspaceId: 'w',
    runDir: '/x',
    exit: 'ok',
    exitCode: 0,
    wallMs: 1000,
    tampered: [],
    grade: { pass, checks: [{ name: 'c', ok: pass }] },
    metrics: {
      llmCalls: 1,
      llmFailures: 0,
      promptTokens: tokens,
      completionTokens: 0,
      totalTokens: tokens,
      toolCalls: 0,
      toolCallsByModule: {},
      toolCallsByName: {},
    },
    armResult: null,
  };
}

describe('buildChildEnv', () => {
  const run = {
    arm: 'single' as ArmId,
    dataRoot: '/d',
    workDir: '/d/workspaces/w',
    workspaceId: 'w',
    instanceId: 'i',
    maxTicks: 60,
    maxRounds: 150,
  };

  it('scrubs shared-memory and inherited inner env, then sets per-run isolation', () => {
    const env = buildChildEnv(
      {
        PATH: '/bin',
        DRIVE9_API_KEY: 'x',
        MEM9_API_KEY: 'x',
        OPENKURONEKO_OB_SKILL_POOL: '/pool',
        INNER_BURST_ID: 'stale',
        UTLRA_DATA_ROOT: '/prod',
        ZHIPU_API_KEY: 'real',
      },
      run,
      null,
    );
    assert.equal(env['PATH'], '/bin');
    assert.equal(env['ZHIPU_API_KEY'], 'real');
    for (const k of ['DRIVE9_API_KEY', 'MEM9_API_KEY', 'OPENKURONEKO_OB_SKILL_POOL', 'INNER_BURST_ID']) {
      assert.equal(env[k], undefined, k);
    }
    assert.equal(env['UTLRA_DATA_ROOT'], '/d');
    assert.equal(env['INNER_WORK_DIR'], '/d/workspaces/w');
    assert.equal(env['INNER_BASE_NODE_MAX_ROUNDS'], '150');
  });

  it('gives the round cap only to the single arm', () => {
    const env = buildChildEnv({}, { ...run, arm: 'dyflow' }, null);
    assert.equal(env['INNER_BASE_NODE_MAX_ROUNDS'], undefined);
    assert.equal(env['ABLATION_MAX_TICKS'], '60');
  });
});

describe('pickNextJob', () => {
  const t = (id: string, exclusiveGroup?: string) => ({ task: { ...SMOKE_TASKS[0]!, id, ...(exclusiveGroup ? { exclusiveGroup } : {}) } });

  it('skips jobs whose exclusive group is running', () => {
    const pending = [t('a', 'viz-server'), t('b', 'viz-server'), t('c')];
    assert.equal(pickNextJob(pending, new Set()), 0);
    assert.equal(pickNextJob(pending, new Set(['viz-server'])), 2);
    assert.equal(pickNextJob(pending, new Set(['viz-server', 'c'])), -1);
  });

  it('defaults the group to the task id', () => {
    assert.equal(pickNextJob([t('c'), t('d')], new Set(['c'])), 1);
  });
});

describe('collectRunMetrics', () => {
  it('sums usage and counts tool.call events by module and name', () => {
    const dataRoot = path.join(tmpRoot, 'm', 'data');
    const workDir = path.join(dataRoot, 'workspaces', 'ws1');
    fs.mkdirSync(path.join(dataRoot, 'usage'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'inner', 'tool-logs', 'ws1'), { recursive: true });
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, 'usage', 'llm-usage.jsonl'),
      [
        { promptTokens: 100, completionTokens: 10, totalTokens: 110, ok: true },
        { promptTokens: 50, completionTokens: 5, totalTokens: 55, ok: false },
      ].map(e => JSON.stringify(e)).join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dataRoot, 'inner', 'tool-logs', 'ws1', '2026-10-15.jsonl'),
      [
        { event: 'tool.call', module: 'base-node', data: { name: 'shell_exec' } },
        { event: 'tool.result', module: 'base-node', data: { name: 'shell_exec' } },
        { event: 'tool.call', module: 'base-node', data: { name: 'write_file' } },
        { event: 'tool.call', module: 'designer', data: { name: 'commit_local_dag' } },
      ].map(e => JSON.stringify(e)).join('\n') + '\n',
    );
    fs.writeFileSync(path.join(workDir, '.brain', 'dyflow-state.json'), JSON.stringify({ mode: 'DONE' }));
    fs.writeFileSync(path.join(workDir, '.brain', 'memory.json'), JSON.stringify({ dag_history: [{}, {}] }));

    const m = collectRunMetrics({ dataRoot, workspaceId: 'ws1', workDir });
    assert.equal(m.llmCalls, 2);
    assert.equal(m.llmFailures, 1);
    assert.equal(m.totalTokens, 165);
    assert.equal(m.toolCalls, 3);
    assert.deepEqual(m.toolCallsByModule, { 'base-node': 2, designer: 1 });
    assert.equal(m.toolCallsByName['shell_exec'], 1);
    assert.equal(m.dyflowMode, 'DONE');
    assert.equal(m.dagRounds, 2);
    assert.equal(m.singleStatus, undefined);
  });
});

describe('buildReport verdict (INNER-ABLATION §8)', () => {
  const meta = { startedAt: 'a', finishedAt: 'b', repeats: 3, fake: false };
  const grid = (passA: number[], passB: number[]) => {
    const runs: RunRecord[] = [];
    passA.forEach((p, t) => [1, 2, 3].forEach(rep => runs.push(fakeRun('dyflow', `t${t}`, rep, rep <= p, 1000))));
    passB.forEach((p, t) => [1, 2, 3].forEach(rep => runs.push(fakeRun('single', `t${t}`, rep, rep <= p, 400))));
    return runs;
  };

  it('needs A to win by at least 2 tasks worth of repeats', () => {
    assert.equal(buildReport(grid([3, 3, 3, 0], [3, 0, 0, 0]), meta).verdict, 'dyflow_effective');
    assert.equal(buildReport(grid([3, 3, 2, 0], [3, 0, 0, 0]), meta).verdict, 'not_shown_necessary');
  });

  it('is incomplete with fewer than 3 repeats or a missing arm', () => {
    assert.equal(buildReport(grid([3], [0]), { ...meta, repeats: 2 }).verdict, 'incomplete');
    assert.equal(buildReport(grid([3], []), meta).verdict, 'incomplete');
  });

  it('reports tokens per pass per arm', () => {
    const r = buildReport(grid([3, 0], [1, 0]), meta);
    const a = r.arms.find(x => x.arm === 'dyflow')!;
    const b = r.arms.find(x => x.arm === 'single')!;
    assert.equal(a.tokensPerPass, Math.round((6 * 1000) / 3));
    assert.equal(b.tokensPerPass, 6 * 400);
    assert.equal(r.cells.find(c => c.taskId === 't0' && c.arm === 'dyflow')!.passes, 3);
  });
});

describe('sandbox', () => {
  it('kill shims refuse host-wide node kills but pass targeted ones through', () => {
    const { binDir, nodeBin } = prepareSandboxBin(path.join(tmpRoot, 'sb'));
    assert.equal(path.basename(nodeBin), 'abl-node');
    const workDir = path.join(tmpRoot, 'sb-work');
    fs.mkdirSync(workDir, { recursive: true });
    const env = { ...process.env, INNER_WORK_DIR: workDir };
    const blocked = spawnSync(path.join(binDir, 'killall'), ['-9', 'node'], { env, encoding: 'utf8' });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /refused/);
    assert.match(fs.readFileSync(path.join(workDir, BLOCKED_KILL_LOG), 'utf8'), /killall -9 node/);
    const targeted = spawnSync(path.join(binDir, 'pkill'), ['-f', 'no-such-process-ablation-xyz'], { env, encoding: 'utf8' });
    assert.notEqual(targeted.stderr, undefined);
    assert.doesNotMatch(targeted.stderr, /refused/);
  });

  it('cleanupHostResidue kills processes left running from the work dir', async () => {
    const workDir = path.join(tmpRoot, 'residue-work');
    fs.mkdirSync(workDir, { recursive: true });
    const script = path.join(workDir, 'linger.cjs');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
    child.unref();
    await new Promise(r => setTimeout(r, 300));
    const residue = cleanupHostResidue(workDir);
    assert.ok(residue.includes(`pid:${child.pid}`), JSON.stringify(residue));
  });
});

describe('fake LLM end-to-end smoke', () => {
  it('both arms pass fake-hello in isolated child processes', { timeout: 180_000 }, async () => {
    const outDir = path.join(tmpRoot, 'smoke');
    const report = await runAblation({
      arms: ['dyflow', 'single'],
      tasks: [...SMOKE_TASKS],
      repeats: 1,
      concurrency: 2,
      fake: true,
      outDir,
      timeoutMs: 120_000,
      maxTicks: 20,
      maxRounds: 10,
      log: () => {},
    });
    const byArm = Object.fromEntries(report.runs.map(r => [r.arm, r]));
    for (const arm of ['dyflow', 'single'] as const) {
      const r = byArm[arm]!;
      assert.equal(r.grade.pass, true, `${arm}: ${JSON.stringify(r.grade.checks)} log=${path.join(r.runDir, 'worker.log')}`);
      assert.equal(r.exit, 'ok');
      assert.ok(r.metrics.llmCalls > 0);
      assert.equal(r.metrics.toolCallsByName['write_file'], 1);
    }
    assert.equal(byArm['dyflow']!.metrics.dyflowMode, 'DONE');
    assert.equal(byArm['single']!.metrics.singleStatus, 'ok');
    assert.equal(byArm['single']!.metrics.dyflowMode, undefined);
    assert.ok(byArm['dyflow']!.metrics.llmCalls > byArm['single']!.metrics.llmCalls);
    assert.ok(fs.existsSync(path.join(outDir, 'report.md')));

    const logs: string[] = [];
    const resumed = await runAblation({
      arms: ['dyflow', 'single'],
      tasks: [...SMOKE_TASKS],
      repeats: 1,
      concurrency: 1,
      fake: true,
      outDir,
      timeoutMs: 120_000,
      maxTicks: 20,
      maxRounds: 10,
      resume: true,
      log: l => logs.push(l),
    });
    assert.equal(resumed.runs.length, 2);
    assert.ok(!logs.some(l => l.startsWith('[start]')), logs.join('\n'));
  });
});
