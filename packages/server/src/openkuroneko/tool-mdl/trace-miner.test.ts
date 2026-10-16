import { describe, expect, it } from 'vitest';

import { mineCandidates, reEncode } from './trace-miner.js';

type Rec = { runId: string; step: number; symbol: string; args: Record<string, unknown> };

function trace(runId: string, symbols: string[]): Rec[] {
  return symbols.map((symbol, step) => ({ runId, step, symbol, args: { i: step } }));
}

describe('traceMiner', () => {
  describe('mineCandidates — 植入的复发片段应被挖出', () => {
    it('finds a planted subsequence that repeats across runs', () => {
      const traces = [
        ...trace('r1', ['ls', 'grep', 'jq', 'tee']),
        ...trace('r2', ['cat', 'grep', 'jq', 'wc']),
        ...trace('r3', ['grep', 'jq', 'sort']),
      ];
      const cands = mineCandidates(traces, { minSupport: 3, minGain: 0 });
      expect(cands.some(c => c.symbols.join(' ') === 'grep jq')).toBe(true);
    });

    it('reports support and the instances backing each candidate', () => {
      const traces = [...trace('r1', ['grep', 'jq']), ...trace('r2', ['grep', 'jq'])];
      const [top] = mineCandidates(traces, { minSupport: 2, minGain: 0 });
      expect(top.support).toBe(2);
      expect(top.instances).toHaveLength(2);
      expect(top.instances[0]).toMatchObject({ runId: 'r1', startStep: 0 });
    });

    it('does not mine across a run boundary', () => {
      const traces = [...trace('r1', ['a', 'tail']), ...trace('r2', ['tail', 'a'])];
      const cands = mineCandidates(traces, { minSupport: 2, minGain: 0 });
      expect(cands.some(c => c.symbols.join(' ') === 'tail a')).toBe(false);
    });

    it('respects minSupport', () => {
      const traces = [...trace('r1', ['grep', 'jq']), ...trace('r2', ['grep', 'jq'])];
      expect(mineCandidates(traces, { minSupport: 3, minGain: 0 })).toEqual([]);
    });

    it('respects minGain so trivial pairs like `cd; ls` are dropped', () => {
      const traces = [
        ...trace('r1', ['cd', 'ls']),
        ...trace('r2', ['cd', 'ls']),
        ...trace('r3', ['cd', 'ls']),
      ];
      const loose = mineCandidates(traces, { minSupport: 3, minGain: 0 });
      expect(loose.length).toBeGreaterThan(0);
      const strict = mineCandidates(traces, { minSupport: 3, minGain: 1_000 });
      expect(strict).toEqual([]);
    });

    it('orders candidates by descending gain (BPE 贪心序)', () => {
      const traces = [
        ...trace('r1', ['a', 'b', 'c', 'd']),
        ...trace('r2', ['a', 'b', 'c', 'd']),
        ...trace('r3', ['a', 'b', 'c', 'd']),
        ...trace('r4', ['x', 'y']),
        ...trace('r5', ['x', 'y']),
      ];
      const cands = mineCandidates(traces, { minSupport: 2, minGain: 0 });
      const gains = cands.map(c => c.gain);
      expect([...gains].sort((p, q) => q - p)).toEqual(gains);
    });

    it('returns nothing on a corpus with no recurrence (前置条件)', () => {
      const traces = [...trace('r1', ['a', 'b']), ...trace('r2', ['c', 'd'])];
      expect(mineCandidates(traces, { minSupport: 2, minGain: 0 })).toEqual([]);
    });
  });

  describe('reEncode — M8：不重编码则层级恒为 1', () => {
    it('rewrites occurrences of a library tool into a single symbol', () => {
      const traces = trace('r1', ['ls', 'grep', 'jq', 'tee']);
      const out = reEncode(traces, [{ name: 'gj', symbols: ['grep', 'jq'] }]);
      expect(out.map(r => r.symbol)).toEqual(['ls', 'gj', 'tee']);
    });

    it('enables a depth-2 candidate on the next mining pass', () => {
      const raw = [
        ...trace('r1', ['grep', 'jq', 'tee']),
        ...trace('r2', ['grep', 'jq', 'tee']),
      ];
      expect(mineCandidates(raw, { minSupport: 2, minGain: 0 }).some(c => c.symbols.includes('gj'))).toBe(
        false,
      );

      const encoded = reEncode(raw, [{ name: 'gj', symbols: ['grep', 'jq'] }]);
      const next = mineCandidates(encoded, { minSupport: 2, minGain: 0 });
      expect(next.some(c => c.symbols.join(' ') === 'gj tee')).toBe(true);
    });

    it('prefers the longest library match at a given position', () => {
      const traces = trace('r1', ['a', 'b', 'c']);
      const out = reEncode(traces, [
        { name: 'ab', symbols: ['a', 'b'] },
        { name: 'abc', symbols: ['a', 'b', 'c'] },
      ]);
      expect(out.map(r => r.symbol)).toEqual(['abc']);
    });

    it('is a no-op for an empty library', () => {
      const traces = trace('r1', ['a', 'b']);
      expect(reEncode(traces, []).map(r => r.symbol)).toEqual(['a', 'b']);
    });
  });
});
