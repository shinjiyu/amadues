import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTrace, type TraceRecord } from './action-log.js';
import { runGrowthCycle, type GrowthPorts } from './growth-cycle.js';
import { runReactKernel, type KernelExecutorPort, type KernelLlmPort } from './react-kernel.js';
import { loadLibrary } from './tool-library.js';

/**
 * 端到端：冻结内核跑一批带复发结构的任务 → 外循环挖出复发片段并收录成工具
 * → 同一批任务重跑，成本下降。这是 ADL 的核心主张，且下降必须归因于自建工具。
 */

const BIG = 'row\n'.repeat(400); // 中间观测：成本主项

/**
 * 脚本化的模型。词汇表里有 grep_jq 就用它（1 步），没有就 grep→jq（2 步）。
 * 这里模拟的是「新词汇被利用」，不是模型智能。
 */
function makeLlm(task: string): KernelLlmPort {
  let phase = 0;
  return async (prompt: string) => {
    const hasTool = /(^|\n)- grep_jq\(/.test(prompt);
    const plan = hasTool ? ['grep_jq'] : ['grep', 'jq'];
    if (phase >= plan.length) return { done: true, answer: `done:${task}` };
    const symbol = plan[phase];
    phase += 1;
    return {
      done: false,
      call:
        symbol === 'grep_jq'
          ? { name: 'grep_jq', args: { pattern: task } }
          : { name: 'shell_exec', args: { command: `${symbol} ${task} data.txt` } },
    };
  };
}

/** grep / jq 各自吐大段中间观测；合成工具一次吐一行小结 */
const executor: KernelExecutorPort = async call => {
  if (call.name === 'grep_jq') return { ok: true, observation: 'summary: 3 rows' };
  return { ok: true, observation: BIG };
};

const TASKS = ['alpha', 'beta', 'gamma', 'delta'];

async function runBatch(workDir: string, tag: string): Promise<{ obsTokens: number; steps: number }> {
  let obsTokens = 0;
  let steps = 0;
  for (const task of TASKS) {
    const res = await runReactKernel({
      workDir,
      runId: `${tag}-${task}`,
      task,
      llm: makeLlm(task),
      executor,
      budgetSteps: 6,
      maxObservationChars: 5_000,
    });
    obsTokens += res.observationTokens;
    steps += res.steps;
  }
  return { obsTokens, steps };
}

function tracesFor(workDir: string, tag: string): TraceRecord[] {
  return TASKS.flatMap(t => readTrace(workDir, `${tag}-${t}`));
}

const ports: GrowthPorts = {
  antiUnify: async cand => ({
    manifest: {
      name: 'grep_jq',
      description: 'Filter rows then project fields.',
      args: { pattern: { type: 'string', required: true } },
      deps: [],
      kind: 'composition',
      createdAt: '2026-09-17T00:00:00.000Z',
      minedFrom: { symbols: cand.symbols, support: cand.support },
    },
    body: '#!/bin/sh\necho "summary: 3 rows"\n',
    fixtures: cand.instances.map(i => ({
      args: { pattern: i.runId },
      expected: 'summary: 3 rows',
      provenance: { kind: 'original_replay' as const },
    })),
  }),
  runTool: async () => ({ ok: true, output: 'summary: 3 rows' }),
};

describe('toolMdlGrowth (component integration)', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-mdl-e2e-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('mines a planted recurrence and cuts per-task cost on the next batch', async () => {
    const before = await runBatch(root, 'b1');
    expect(before.steps).toBe(TASKS.length * 2);
    expect(loadLibrary(root)).toEqual([]);

    const grown = await runGrowthCycle(
      {
        workDir: root,
        traces: tracesFor(root, 'b1'),
        minSupport: 4,
        minGain: 1,
        remainingSteps: 50,
        maxAcceptPerCycle: 1,
      },
      ports,
    );

    expect(grown.accepted.map(a => a.name)).toEqual(['grep_jq']);
    expect(grown.accepted[0].deltaL).toBeLessThan(0);
    expect(loadLibrary(root).map(t => t.name)).toEqual(['grep_jq']);

    const after = await runBatch(root, 'b2');

    // 步数折半：两个终结符折成一个非终结符
    expect(after.steps).toBe(TASKS.length);
    // 成本主项是被工具吞掉的中间观测
    expect(after.obsTokens).toBeLessThan(before.obsTokens / 10);
  });

  it('attributes the saving to a self-created composition tool, not to acquisition (M9)', async () => {
    await runBatch(root, 'b1');
    await runGrowthCycle(
      {
        workDir: root,
        traces: tracesFor(root, 'b1'),
        minSupport: 4,
        minGain: 1,
        remainingSteps: 50,
        maxAcceptPerCycle: 1,
      },
      ports,
    );
    const lib = loadLibrary(root);
    expect(lib).toHaveLength(1);
    expect(lib[0].manifest.kind).toBe('composition');
    expect(lib[0].manifest.minedFrom?.symbols).toEqual(['grep', 'jq']);
  });

  it('leaves the library empty when the task stream has no recurrence', async () => {
    let n = 0;
    for (const task of TASKS) {
      const uniq = `cmd${n}`;
      n += 1;
      await runReactKernel({
        workDir: root,
        runId: `nr-${task}`,
        task,
        llm: (() => {
          let used = false;
          const port: KernelLlmPort = async () => {
            if (used) return { done: true, answer: 'ok' };
            used = true;
            return { done: false, call: { name: 'shell_exec', args: { command: `${uniq} x` } } };
          };
          return port;
        })(),
        executor,
        budgetSteps: 4,
      });
    }

    const res = await runGrowthCycle(
      {
        workDir: root,
        traces: TASKS.flatMap(t => readTrace(root, `nr-${t}`)),
        minSupport: 2,
        minGain: 1,
        remainingSteps: 50,
      },
      ports,
    );
    expect(res.candidates).toBe(0);
    expect(res.accepted).toEqual([]);
    expect(loadLibrary(root)).toEqual([]);
  });
});
