import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DESCRIPTION_TOKEN_BUDGET,
  manifestCostTokens,
  parseToolManifest,
  validateToolManifest,
} from './tool-manifest.js';

const ok = {
  name: 'extract_csv',
  description: 'Extract matching rows into a CSV file.',
  args: {
    pattern: { type: 'string', required: true },
    out: { type: 'string', required: true },
  },
  deps: [],
  kind: 'composition',
  createdAt: '2026-09-17T00:00:00.000Z',
};

describe('toolManifest', () => {
  it('accepts a well-formed composition manifest', () => {
    expect(validateToolManifest(ok)).toEqual([]);
  });

  describe('M7 — description token 硬上限', () => {
    it('rejects a description over the budget', () => {
      const long = { ...ok, description: 'word '.repeat(DEFAULT_DESCRIPTION_TOKEN_BUDGET + 5) };
      expect(validateToolManifest(long).join(' ')).toMatch(/description/);
    });

    it('honours a caller-supplied tighter budget', () => {
      expect(validateToolManifest(ok, { descriptionTokenBudget: 2 }).join(' ')).toMatch(
        /description/,
      );
    });
  });

  describe('M9 — acquisition 默认禁止', () => {
    it('rejects kind=acquisition unless explicitly allowed', () => {
      const acq = { ...ok, kind: 'acquisition' };
      expect(validateToolManifest(acq).join(' ')).toMatch(/acquisition/);
      expect(validateToolManifest(acq, { allowAcquisition: true })).toEqual([]);
    });

    it('rejects an unknown kind', () => {
      expect(validateToolManifest({ ...ok, kind: 'magic' }).length).toBeGreaterThan(0);
    });
  });

  describe('name / args / deps', () => {
    it('requires a snake_case name', () => {
      expect(validateToolManifest({ ...ok, name: 'Extract CSV' }).length).toBeGreaterThan(0);
      expect(validateToolManifest({ ...ok, name: '' }).length).toBeGreaterThan(0);
    });

    it('rejects an unsupported arg type', () => {
      const bad = { ...ok, args: { x: { type: 'object' } } };
      expect(validateToolManifest(bad).join(' ')).toMatch(/type/);
    });

    it('rejects a self-dependency', () => {
      expect(
        validateToolManifest({ ...ok, deps: ['extract_csv'] }).join(' '),
      ).toMatch(/deps/);
    });
  });

  describe('parseToolManifest', () => {
    it('parses valid json', () => {
      expect(parseToolManifest(JSON.stringify(ok))?.name).toBe('extract_csv');
    });

    it('returns null on malformed json', () => {
      expect(parseToolManifest('{ not json')).toBeNull();
    });

    it('returns null when validation fails', () => {
      expect(parseToolManifest(JSON.stringify({ ...ok, kind: 'acquisition' }))).toBeNull();
    });
  });

  describe('manifestCostTokens — 文法代价', () => {
    it('counts name plus description plus arg names', () => {
      const cost = manifestCostTokens(ok as never);
      expect(cost).toBeGreaterThan(0);
      const richer = manifestCostTokens({
        ...ok,
        description: `${ok.description} And some more words here.`,
      } as never);
      expect(richer).toBeGreaterThan(cost);
    });
  });
});
