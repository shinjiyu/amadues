import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTrace } from './action-log.js';
import { KERNEL_SOURCE_FILES, runReactKernel } from './react-kernel.js';
import type { KernelLlmPort, KernelExecutorPort } from './react-kernel.js';

function scriptedLlm(steps: Array<{ action?: string; tool?: string; args?: Record<string, unknown>; done?: string }>): {
  port: KernelLlmPort;
  prompts: string[];
} {
  const prompts: string[] = [];
  let i = 0;
  const port: KernelLlmPort = async prompt => {
    prompts.push(prompt);
    const s = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (s.done !== undefined) return { thought: 'done', done: true, answer: s.done };
    return {
      thought: 't',
      done: false,
      call: { name: s.tool ?? 'shell_exec', args: s.args ?? { command: s.action ?? 'true' } },
    };
  };
  return { port, prompts };
}

const echoExecutor: KernelExecutorPort = async call => ({
  ok: true,
  observation: `ran ${call.name} ${JSON.stringify(call.args)}`,
});

describe('reactKernel', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-mdl-kernel-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs to completion and reports the answer', async () => {
    const { port } = scriptedLlm([{ action: 'echo hi' }, { done: 'finished' }]);
    const res = await runReactKernel({
      workDir: root,
      runId: 'r1',
      task: 'say hi',
      llm: port,
      executor: echoExecutor,
      budgetSteps: 5,
    });
    expect(res.done).toBe(true);
    expect(res.answer).toBe('finished');
    expect(res.steps).toBe(1);
  });

  describe('M1 — 内核冻结', () => {
    it('never puts kernel source into the prompt', async () => {
      const { port, prompts } = scriptedLlm([{ action: 'echo hi' }, { done: 'ok' }]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 'say hi',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 5,
      });
      const all = prompts.join('\n');
      for (const f of KERNEL_SOURCE_FILES) expect(all).not.toContain(f);
      expect(all).not.toMatch(/runReactKernel/);
      expect(all).not.toMatch(/budgetSteps/);
    });

    it('exposes only shell_exec plus the tool index as the action space (M2)', async () => {
      const { port, prompts } = scriptedLlm([{ done: 'ok' }]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 3,
      });
      expect(prompts[0]).toMatch(/shell_exec/);
      expect(prompts[0]).not.toMatch(/create_tool/);
    });

    it('offers create_tool only in control arm A (M11)', async () => {
      const { port, prompts } = scriptedLlm([{ done: 'ok' }]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 3,
        inlineCreateTool: true,
      });
      expect(prompts[0]).toMatch(/create_tool/);
    });

    it('does not announce the observation limit by default (§11.14: announcing kills mining)', async () => {
      const { port, prompts } = scriptedLlm([{ done: 'ok' }]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 3,
        maxObservationChars: 1234,
      });
      expect(prompts[0]).not.toMatch(/OBSERVATION LIMIT/);
    });

    it('can announce the observation limit when explicitly enabled', async () => {
      const { port, prompts } = scriptedLlm([{ done: 'ok' }]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 3,
        maxObservationChars: 1234,
        announceObservationLimit: true,
      });
      expect(prompts[0]).toMatch(/OBSERVATION LIMIT: output beyond 1234 chars/);
    });

    it('can suppress the observation-limit notice explicitly', async () => {
      const { port, prompts } = scriptedLlm([{ done: 'ok' }]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 3,
        announceObservationLimit: false,
      });
      expect(prompts[0]).not.toMatch(/OBSERVATION LIMIT/);
    });
  });

  it('truncates observations so context stays bounded', async () => {
    const big: KernelExecutorPort = async () => ({ ok: true, observation: 'x'.repeat(10_000) });
    const { port, prompts } = scriptedLlm([{ action: 'cat big' }, { done: 'ok' }]);
    await runReactKernel({
      workDir: root,
      runId: 'r1',
      task: 't',
      llm: port,
      executor: big,
      budgetSteps: 5,
      maxObservationChars: 200,
    });
    const second = prompts[1];
    expect(second.length).toBeLessThan(4_000);
    expect(second).toMatch(/truncated/);
  });

  it('stops at the step budget without claiming success', async () => {
    const { port } = scriptedLlm([{ action: 'loop' }]);
    const res = await runReactKernel({
      workDir: root,
      runId: 'r1',
      task: 't',
      llm: port,
      executor: echoExecutor,
      budgetSteps: 3,
    });
    expect(res.done).toBe(false);
    expect(res.steps).toBe(3);
    expect(res.stopReason).toBe('budget');
  });

  describe('trace 落盘 (M3/M10)', () => {
    it('writes one structured record per step with both token counters', async () => {
      const { port } = scriptedLlm([
        { action: 'grep -n foo bar.txt' },
        { action: 'jq .items data.json' },
        { done: 'ok' },
      ]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 5,
      });
      const recs = readTrace(root, 'r1');
      expect(recs.map(r => r.symbol)).toEqual(['grep', 'jq']);
      for (const r of recs) {
        expect(typeof r.args).toBe('object');
        expect(Array.isArray(r.args)).toBe(false);
        expect(r.obsTokens).toBeGreaterThan(0);
        expect(r.actionTokens).toBeGreaterThan(0);
      }
    });

    it('records a failed step as ok=false and keeps going', async () => {
      const failing: KernelExecutorPort = async () => ({ ok: false, observation: 'boom' });
      const { port } = scriptedLlm([{ action: 'false' }, { done: 'ok' }]);
      const res = await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: failing,
        budgetSteps: 5,
      });
      expect(res.done).toBe(true);
      expect(readTrace(root, 'r1')[0].ok).toBe(false);
    });

    // M12：判定要看后续动作，所以只能在 run 结束时回填
    it('backfills obsKind on every record (M12)', async () => {
      // 第 0 步的观测里首次出现 data.json，第 1 步的动作用到了它 ⇒ 获取步
      const executor: KernelExecutorPort = async call =>
        String(call.args.command).startsWith('ls')
          ? { ok: true, observation: 'data.json' }
          : { ok: true, observation: 'done' };
      const { port } = scriptedLlm([
        { action: 'ls' },
        { action: 'jq . data.json' },
        { done: 'ok' },
      ]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 'inspect the directory',
        llm: port,
        executor,
        budgetSteps: 5,
      });
      expect(readTrace(root, 'r1').map(r => r.obsKind)).toEqual(['acquisition', 'intermediate']);
    });

    it('backfills obsKind when the run ends on budget exhaustion', async () => {
      const { port } = scriptedLlm([{ action: 'ls' }]);
      await runReactKernel({
        workDir: root,
        runId: 'r1',
        task: 't',
        llm: port,
        executor: echoExecutor,
        budgetSteps: 2,
      });
      const recs = readTrace(root, 'r1');
      expect(recs).toHaveLength(2);
      expect(recs.every(r => r.obsKind !== undefined)).toBe(true);
    });
  });

  it('can withhold finish and keep only the recent history', async () => {
    const { port, prompts } = scriptedLlm([
      { action: 'echo ALPHA' },
      { action: 'echo BETA' },
      { action: 'echo GAMMA' },
      { done: 'ok' },
    ]);
    await runReactKernel({
      workDir: root,
      runId: 'r1',
      task: 't',
      llm: port,
      executor: echoExecutor,
      budgetSteps: 5,
      offerFinish: false,
      maxHistorySteps: 1,
    });
    expect(prompts[0]).not.toContain('or finish');
    expect(prompts[0]).toContain('Do not finish until the required change is committed');
    expect(prompts[2]).toContain('echo BETA');
    expect(prompts[2]).not.toContain('echo ALPHA');
    expect(prompts[2]).toContain('1 earlier steps omitted');
  });
});
