import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TraceRecord } from './action-log.js';
import { runGrowthCycle, type GrowthPorts } from './growth-cycle.js';
import { loadLibrary } from './tool-library.js';

function rec(runId: string, step: number, symbol: string, obsTokens = 50): TraceRecord {
  return {
    runId,
    step,
    symbol,
    args: { i: step },
    obsDigest: `d${step}`,
    obsTokens,
    actionTokens: 5,
    ok: true,
  };
}

/**
 * 植入两层复发：内层 `grep→jq` 出现 4 次，外层 `grep→jq→tee` 出现 3 次，
 * 前缀各不相同。内层更频繁所以先被折叠，折叠后外层才成为可挖的深度 2 单元（M8）。
 * 若让所有 run 完全相同，最大重复单元就是整段 run，折叠整段在压缩上确实更优。
 */
function plantedTraces(): TraceRecord[] {
  const around: Array<[string, string, string]> = [
    ['r1', 'ls', 'tee'],
    ['r2', 'cat', 'tee'],
    ['r3', 'head', 'tee'],
    ['r4', 'wc', 'sort'],
  ];
  return around.flatMap(([id, pre, post]) => [
    rec(id, 0, pre, 5),
    rec(id, 1, 'grep'),
    rec(id, 2, 'jq'),
    rec(id, 3, post, 5),
  ]);
}

function ports(over: Partial<GrowthPorts> = {}): GrowthPorts {
  return {
    antiUnify: async cand => ({
      manifest: {
        name: cand.symbols.join('_'),
        description: `Run ${cand.symbols.join(' then ')}.`,
        args: { input: { type: 'string', required: true } },
        deps: [],
        kind: 'composition',
        createdAt: '2026-09-17T00:00:00.000Z',
        minedFrom: { symbols: cand.symbols, support: cand.support },
      },
      body: '#!/bin/sh\necho ok\n',
      fixtures: cand.instances.map(i => ({
        args: { input: i.runId },
        expected: 'ok',
        provenance: { kind: 'original_replay' as const },
      })),
    }),
    runTool: async () => ({ ok: true, output: 'ok' }),
    ...over,
  };
}

describe('growthCycle', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-mdl-growth-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const base = { minSupport: 3, minGain: 1, remainingSteps: 20, maxAcceptPerCycle: 1 };

  it('mines the planted subsequence and accepts it as a tool', async () => {
    const res = await runGrowthCycle({ workDir: root, traces: plantedTraces(), ...base }, ports());
    expect(res.accepted.map(a => a.name)).toEqual(['grep_jq']);
    expect(loadLibrary(root).map(t => t.name)).toEqual(['grep_jq']);
  });

  it('records the accept in .mdl.json with a negative deltaL', async () => {
    const res = await runGrowthCycle({ workDir: root, traces: plantedTraces(), ...base }, ports());
    expect(res.accepted[0].deltaL).toBeLessThan(0);
  });

  it('produces nothing on a corpus with no recurrence (前置条件)', async () => {
    const traces = [rec('r1', 0, 'a'), rec('r2', 0, 'b'), rec('r3', 0, 'c')];
    const res = await runGrowthCycle({ workDir: root, traces, ...base }, ports());
    expect(res.accepted).toEqual([]);
    expect(loadLibrary(root)).toEqual([]);
  });

  describe('拒绝路径', () => {
    it('rejects a candidate whose replay fails (M5)', async () => {
      const res = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base },
        ports({ runTool: async () => ({ ok: true, output: 'WRONG' }) }),
      );
      expect(res.accepted).toEqual([]);
      expect(res.rejected[0].reason).toBe('replay_failed');
      expect(loadLibrary(root)).toEqual([]);
    });

    it('rejects when the model returns nothing', async () => {
      const res = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base },
        ports({ antiUnify: async () => null }),
      );
      expect(res.rejected[0].reason).toBe('antiunify_empty');
    });

    it('rejects when MDL delta is non-negative (M4)', async () => {
      const res = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base, remainingSteps: 1_000_000 },
        ports(),
      );
      expect(res.accepted).toEqual([]);
      expect(res.rejected[0].reason).toBe('mdl_not_negative');
    });

    it('rejects an invalid manifest without writing anything', async () => {
      const res = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base },
        ports({
          antiUnify: async cand => ({
            manifest: {
              name: 'Bad Name',
              description: 'x',
              args: {},
              deps: [],
              kind: 'composition',
              createdAt: 'now',
            },
            body: 'x',
            fixtures: cand.instances.map(i => ({
              args: {},
              expected: 'ok',
              provenance: { kind: 'original_replay' as const },
            })),
          }),
        }),
      );
      expect(res.rejected[0].reason).toBe('invalid_manifest');
      expect(loadLibrary(root)).toEqual([]);
    });
  });

  it('honours maxAcceptPerCycle', async () => {
    const traces = ['r1', 'r2', 'r3'].flatMap(id => [
      rec(id, 0, 'grep'),
      rec(id, 1, 'jq'),
      rec(id, 2, 'sort'),
      rec(id, 3, 'uniq'),
    ]);
    const res = await runGrowthCycle(
      { workDir: root, traces, minSupport: 3, minGain: 1, remainingSteps: 20, maxAcceptPerCycle: 2 },
      ports(),
    );
    expect(res.accepted.length).toBeLessThanOrEqual(2);
  });

  describe('M8 — 重编码使层级出现', () => {
    it('mines a depth-2 candidate on the cycle after the first accept', async () => {
      const first = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base },
        ports(),
      );
      expect(first.accepted.map(a => a.name)).toEqual(['grep_jq']);

      const second = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base, minGain: 0 },
        ports(),
      );
      const names = second.accepted.map(a => a.name).concat(second.rejected.map(r => r.name));
      expect(names.some(n => n.includes('grep_jq'))).toBe(true);
    });
  });

  describe('退役走同一个目标 (M6)', () => {
    it('retires a library tool that the corpus never calls', async () => {
      await runGrowthCycle({ workDir: root, traces: plantedTraces(), ...base }, ports());
      expect(loadLibrary(root).map(t => t.name)).toEqual(['grep_jq']);

      const unrelated = ['r9'].flatMap(id => [rec(id, 0, 'cat'), rec(id, 1, 'wc')]);
      const res = await runGrowthCycle(
        { workDir: root, traces: unrelated, ...base, remainingSteps: 10_000 },
        ports(),
      );
      expect(res.retired).toContain('grep_jq');
      expect(loadLibrary(root)).toEqual([]);
    });

    it('keeps a tool the corpus still calls heavily', async () => {
      await runGrowthCycle({ workDir: root, traces: plantedTraces(), ...base }, ports());
      const res = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base },
        ports(),
      );
      expect(res.retired).not.toContain('grep_jq');
      expect(loadLibrary(root).map(t => t.name)).toContain('grep_jq');
    });

    /**
     * §11.15：工具被采用后，语料里不再出现原始 `grep→jq`，只剩工具名。
     * 若退役仍从 minedFrom.symbols 回算节省，会得到 0 → 误杀刚成功的工具。
     */
    it('does not retire a heavily used tool just because the surface pattern is gone', async () => {
      await runGrowthCycle({ workDir: root, traces: plantedTraces(), ...base }, ports());
      expect(loadLibrary(root).map(t => t.name)).toEqual(['grep_jq']);
      expect(loadLibrary(root)[0].manifest.minedFrom?.savedTokensPerUse).toBeGreaterThan(0);

      // 模型已完全改用工具：语料里只有工具调用，原始片段消失
      const adopted = ['a', 'b', 'c', 'd'].flatMap((id, i) => [
        rec(id, 0, 'grep_jq', 5),
        rec(id, 1, 'tee', 5),
      ]);
      const res = await runGrowthCycle(
        { workDir: root, traces: adopted, ...base, remainingSteps: 20 },
        ports(),
      );
      expect(res.retired).not.toContain('grep_jq');
      expect(loadLibrary(root).map(t => t.name)).toContain('grep_jq');
    });
  });

  /**
   * M12：获取步的观测不可压缩——信息仍须送达 agent。把它记成节省会让必然亏本的
   * 工具通过闸门，这是 P2 真实 LLM 下成本反向上升的根因。
   */
  describe('获取步的观测不得记为节省 (M12)', () => {
    it('accepts when the folded observations are intermediate', async () => {
      const traces = plantedTraces().map(r => ({ ...r, obsKind: 'intermediate' as const }));
      const res = await runGrowthCycle({ workDir: root, traces, ...base }, ports());
      expect(res.accepted.map(a => a.name)).toContain('grep_jq');
    });

    it('rejects the same candidate once those observations are acquisition', async () => {
      const traces = plantedTraces().map(r => ({ ...r, obsKind: 'acquisition' as const }));
      const res = await runGrowthCycle({ workDir: root, traces, ...base }, ports());
      expect(res.accepted).toEqual([]);
      expect(res.rejected.map(r => r.reason)).toContain('mdl_not_negative');
    });

    it('treats a trace without obsKind as intermediate (backward compatible)', async () => {
      const res = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base },
        ports(),
      );
      expect(res.accepted.map(a => a.name)).toContain('grep_jq');
    });
  });

  describe('夹具必须独立推导 (M5a)', () => {
    it('rejects fixtures that omit provenance', async () => {
      const res = await runGrowthCycle(
        { workDir: root, traces: plantedTraces(), ...base },
        ports({
          antiUnify: async cand => ({
            manifest: {
              name: cand.symbols.join('_'),
              description: 'x',
              args: {},
              deps: [],
              kind: 'composition',
              createdAt: '2026-09-17T00:00:00.000Z',
            },
            body: '#!/bin/sh\necho ok\n',
            // 故意不标 provenance —— 这是闸门自指时的形状
            fixtures: [{ args: {}, expected: 'ok' }],
          }),
        }),
      );
      expect(res.accepted).toEqual([]);
      expect(res.rejected.map(r => r.reason)).toContain('invalid_fixtures');
    });
  });
});
