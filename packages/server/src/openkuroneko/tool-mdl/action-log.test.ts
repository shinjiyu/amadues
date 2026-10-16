import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendTrace,
  classifyObservations,
  countTokens,
  createTraceRecord,
  readTrace,
  rewriteTrace,
  symbolOf,
  validateTraceRecord,
} from './action-log.js';

describe('actionLog', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-mdl-log-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  describe('symbolOf — argv[0] 作为挖掘字母表', () => {
    it('extracts the program name from a shell command', () => {
      expect(symbolOf('grep -n foo bar.txt')).toBe('grep');
      expect(symbolOf('  jq   .items  ')).toBe('jq');
      expect(symbolOf('/usr/bin/python3 run.py')).toBe('python3');
    });

    it('strips env prefixes so the symbol is the real program', () => {
      expect(symbolOf('FOO=1 BAR=2 curl https://x')).toBe('curl');
    });

    it('falls back to a stable sentinel for empty commands', () => {
      expect(symbolOf('   ')).toBe('<empty>');
    });
  });

  describe('validateTraceRecord — M3 结构化参数', () => {
    const base = {
      runId: 'r1',
      step: 0,
      symbol: 'grep',
      args: { pattern: 'foo', file: 'bar.txt' },
      obsDigest: 'abc',
      obsTokens: 12,
      actionTokens: 5,
      ok: true,
    };

    it('accepts a well-formed record', () => {
      expect(validateTraceRecord(base)).toEqual([]);
    });

    it('rejects a string blob for args (M3)', () => {
      const errs = validateTraceRecord({ ...base, args: 'grep -n foo bar.txt' });
      expect(errs.join(' ')).toMatch(/args/);
    });

    it('rejects an array for args (M3)', () => {
      expect(validateTraceRecord({ ...base, args: ['a', 'b'] }).length).toBeGreaterThan(0);
    });

    it('requires both token counters separately (M10)', () => {
      const noObs = validateTraceRecord({ ...base, obsTokens: undefined });
      expect(noObs.join(' ')).toMatch(/obsTokens/);
      const noAction = validateTraceRecord({ ...base, actionTokens: undefined });
      expect(noAction.join(' ')).toMatch(/actionTokens/);
    });

    it('rejects a missing symbol', () => {
      expect(validateTraceRecord({ ...base, symbol: '' }).length).toBeGreaterThan(0);
    });
  });

  describe('createTraceRecord', () => {
    it('derives the symbol and counts observation tokens', () => {
      const rec = createTraceRecord({
        runId: 'r1',
        step: 3,
        command: 'jq .items data.json',
        args: { filter: '.items', file: 'data.json' },
        observation: 'aaa bbb ccc ddd',
        ok: true,
      });
      expect(rec.symbol).toBe('jq');
      expect(rec.obsTokens).toBe(countTokens('aaa bbb ccc ddd'));
      expect(rec.actionTokens).toBeGreaterThan(0);
      expect(rec.obsDigest).toHaveLength(16);
    });
  });

  describe('append / read round-trip', () => {
    it('writes jsonl under runs/<runId>/ and reads it back in order', () => {
      const mk = (step: number, symbol: string) => ({
        runId: 'r1',
        step,
        symbol,
        args: { i: step },
        obsDigest: `d${step}`,
        obsTokens: 1,
        actionTokens: 1,
        ok: true,
      });
      appendTrace(root, mk(0, 'grep'));
      appendTrace(root, mk(1, 'jq'));
      appendTrace(root, mk(2, 'grep'));

      const back = readTrace(root, 'r1');
      expect(back.map(r => r.symbol)).toEqual(['grep', 'jq', 'grep']);
      expect(fs.existsSync(path.join(root, 'runs', 'r1', 'trace.jsonl'))).toBe(true);
    });

    it('throws rather than persisting an invalid record (M3)', () => {
      expect(() =>
        appendTrace(root, {
          runId: 'r1',
          step: 0,
          symbol: 'grep',
          args: 'blob' as unknown as Record<string, unknown>,
          obsDigest: 'd',
          obsTokens: 1,
          actionTokens: 1,
          ok: true,
        }),
      ).toThrow(/args/);
      expect(fs.existsSync(path.join(root, 'runs', 'r1', 'trace.jsonl'))).toBe(false);
    });

    it('returns an empty list for an unknown run', () => {
      expect(readTrace(root, 'nope')).toEqual([]);
    });

    it('rewriteTrace backfills obsKind over the whole run (M12)', () => {
      const base = { runId: 'r1', args: {}, obsDigest: 'd', obsTokens: 1, actionTokens: 1, ok: true };
      appendTrace(root, { ...base, step: 0, symbol: 'cat' });
      appendTrace(root, { ...base, step: 1, symbol: 'awk' });

      rewriteTrace(root, 'r1', [
        { ...base, step: 0, symbol: 'cat', obsKind: 'acquisition' },
        { ...base, step: 1, symbol: 'awk', obsKind: 'intermediate' },
      ]);

      expect(readTrace(root, 'r1').map(r => r.obsKind)).toEqual(['acquisition', 'intermediate']);
    });

    // M10：记的是上下文成本，不是执行器产出量
    it('counts the clipped observation, not the raw one', () => {
      const rec = createTraceRecord({
        runId: 'r1',
        step: 0,
        command: 'cat big.txt',
        args: { command: 'cat big.txt' },
        observation: 'x'.repeat(40_000),
        shownObservation: 'x'.repeat(400),
        ok: true,
      });
      expect(rec.obsTokens).toBe(100);
      // 身份仍由完整观测决定，否则截断会把不同产出混为一谈
      expect(rec.obsDigest).not.toBe(
        createTraceRecord({
          runId: 'r1',
          step: 0,
          command: 'cat big.txt',
          args: {},
          observation: 'x'.repeat(400),
          ok: true,
        }).obsDigest,
      );
    });

    it('rejects an unknown obsKind', () => {
      const errs = validateTraceRecord({
        runId: 'r1',
        step: 0,
        symbol: 'cat',
        args: {},
        obsDigest: 'd',
        obsTokens: 1,
        actionTokens: 1,
        ok: true,
        obsKind: 'whatever',
      });
      expect(errs.join()).toMatch(/obsKind/);
    });
  });

  // M12：这一分类直接决定 obsTokens 能否记为「可省」，是 ΔL 正确性的前提
  describe('classifyObservations', () => {
    it('marks an observation acquisition when a later action consumes it', () => {
      const kinds = classifyObservations({
        task: 'filter data/logs-0.tsv by level INFO, print service, write out.csv',
        steps: [
          // 列号只在 schema 里出现，后续 awk 用到了 $2/$3 ⇒ 信息被取走了
          { observation: 'Column 2 -- level\nColumn 3 -- service\nawk field: $2', actionText: 'cat data/schema-0.txt' },
          { observation: '110 out.csv', actionText: "awk -F'\\t' '$2==\"INFO\"{print $3}' data/logs-0.tsv > out.csv" },
        ],
      });
      expect(kinds[0]).toBe('acquisition');
    });

    it('marks a discardable observation intermediate', () => {
      const kinds = classifyObservations({
        task: 'write out.csv then verify it',
        steps: [
          { observation: '110 out.csv', actionText: 'awk -f prog.awk > out.csv' },
          { observation: 'done', actionText: 'wc -l out.csv' },
        ],
      });
      expect(kinds[0]).toBe('intermediate');
    });

    it('never marks the last observation acquisition — nothing follows it', () => {
      const kinds = classifyObservations({
        task: 't',
        steps: [{ observation: 'brand new token zzz9', actionText: 'ls data' }],
      });
      expect(kinds).toEqual(['intermediate']);
    });

    it('does not count tokens the task already supplied', () => {
      const kinds = classifyObservations({
        task: 'use data/logs-0.tsv',
        steps: [
          { observation: 'data/logs-0.tsv', actionText: 'ls data' },
          { observation: 'ok', actionText: 'wc -l data/logs-0.tsv' },
        ],
      });
      expect(kinds[0]).toBe('intermediate');
    });
  });
});
