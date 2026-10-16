import { describe, expect, it } from 'vitest';

import {
  acceptDelta,
  corpusCostTokens,
  crossoverStep,
  grammarCostTokens,
  retireDelta,
  totalDescriptionLength,
} from './mdl-account.js';

const corpus = [
  { symbol: 'grep', actionTokens: 6, obsTokens: 40 },
  { symbol: 'jq', actionTokens: 5, obsTokens: 30 },
  { symbol: 'grep', actionTokens: 6, obsTokens: 40 },
];

describe('mdlAccount', () => {
  describe('cost decomposition (M10)', () => {
    it('corpus cost counts both action and observation tokens', () => {
      expect(corpusCostTokens(corpus)).toBe(6 + 40 + 5 + 30 + 6 + 40);
    });

    it('grammar cost is per-entry cost times the remaining step budget', () => {
      expect(grammarCostTokens([{ name: 'a', costTokens: 10 }], 4)).toBe(40);
    });

    it('total description length is grammar plus corpus', () => {
      const L = totalDescriptionLength({
        library: [{ name: 'a', costTokens: 10 }],
        corpus,
        remainingSteps: 2,
      });
      expect(L).toBe(20 + corpusCostTokens(corpus));
    });
  });

  describe('acceptDelta — 收录判据 (M4)', () => {
    const cand = {
      name: 'grep_then_jq',
      manifestCostTokens: 8,
      support: 10,
      savedTokensPerUse: 30,
      callCostTokens: 4,
      buildCostTokens: 20,
    };

    it('is negative (accept) when reuse pays for the carry cost', () => {
      expect(acceptDelta(cand, { remainingSteps: 5 })).toBeLessThan(0);
    });

    it('is positive (reject) when the tool is rarely reused', () => {
      expect(acceptDelta({ ...cand, support: 1 }, { remainingSteps: 5 })).toBeGreaterThan(0);
    });

    it('is positive (reject) when the index carry cost dominates', () => {
      expect(acceptDelta(cand, { remainingSteps: 10_000 })).toBeGreaterThan(0);
    });

    it('grows more negative as support grows', () => {
      const few = acceptDelta({ ...cand, support: 5 }, { remainingSteps: 5 });
      const many = acceptDelta({ ...cand, support: 50 }, { remainingSteps: 5 });
      expect(many).toBeLessThan(few);
    });
  });

  describe('retireDelta — 退役用同一个目标 (M6)', () => {
    it('is negative (retire) for a tool nobody calls', () => {
      const d = retireDelta(
        { name: 'dead', manifestCostTokens: 8, uses: 0, savedTokensPerUse: 30, callCostTokens: 4 },
        { remainingSteps: 100 },
      );
      expect(d).toBeLessThan(0);
    });

    it('is positive (keep) for a heavily used tool', () => {
      const d = retireDelta(
        { name: 'hot', manifestCostTokens: 8, uses: 200, savedTokensPerUse: 30, callCostTokens: 4 },
        { remainingSteps: 100 },
      );
      expect(d).toBeGreaterThan(0);
    });
  });

  describe('crossoverStep — utility problem 拐点', () => {
    it('finds the library size at which index cost overtakes the saving', () => {
      const at = crossoverStep({ perToolCostTokens: 10, savedTokensPerStep: 100 });
      expect(at).toBe(10);
    });

    it('is Infinity when carrying a tool costs nothing', () => {
      expect(crossoverStep({ perToolCostTokens: 0, savedTokensPerStep: 100 })).toBe(Infinity);
    });

    it('is 0 when the tools save nothing per step', () => {
      expect(crossoverStep({ perToolCostTokens: 10, savedTokensPerStep: 0 })).toBe(0);
    });
  });
});
