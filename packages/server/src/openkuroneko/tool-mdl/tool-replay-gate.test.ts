import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  artifactEffectDigest,
  buildFixturesFromOriginal,
  composeEffectDigest,
  factsEffectDigest,
  readFixtures,
  replayTool,
  validateAcceptFixtures,
  writeFixtures,
  type ReplayFixture,
  type ToolRunner,
} from './tool-replay-gate.js';

const fixtures: ReplayFixture[] = [
  { args: { pattern: 'a' }, expected: 'hit-a', provenance: { kind: 'original_replay' } },
  { args: { pattern: 'b' }, expected: 'hit-b', provenance: { kind: 'original_replay' } },
];

const perfect: ToolRunner = async (_name, args) => ({
  ok: true,
  output: `hit-${String(args.pattern)}`,
});

describe('toolReplayGate', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-mdl-replay-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when every recorded instance reproduces', async () => {
    const v = await replayTool('grep_hit', fixtures, perfect);
    expect(v.pass).toBe(true);
    expect(v.passed).toBe(2);
    expect(v.mismatches).toEqual([]);
  });

  it('fails on any single mismatch (M5: 不过不收)', async () => {
    const flaky: ToolRunner = async (_n, args) =>
      args.pattern === 'b' ? { ok: true, output: 'wrong' } : { ok: true, output: 'hit-a' };
    const v = await replayTool('grep_hit', fixtures, flaky);
    expect(v.pass).toBe(false);
    expect(v.mismatches).toHaveLength(1);
    expect(v.mismatches[0]).toMatchObject({ index: 1, reason: 'mismatch', actual: 'wrong' });
  });

  it('treats a non-ok run as a failure', async () => {
    const broken: ToolRunner = async () => ({ ok: false, output: 'boom' });
    const v = await replayTool('grep_hit', fixtures, broken);
    expect(v.pass).toBe(false);
    expect(v.mismatches[0].reason).toBe('error');
  });

  it('treats a thrown runner as a failure rather than propagating', async () => {
    const throwing: ToolRunner = async () => {
      throw new Error('spawn failed');
    };
    const v = await replayTool('grep_hit', fixtures, throwing);
    expect(v.pass).toBe(false);
    expect(v.mismatches).toHaveLength(2);
    expect(v.mismatches[0].reason).toBe('error');
  });

  it('refuses to pass an empty fixture set (M5: 无夹具即无验收)', async () => {
    const v = await replayTool('grep_hit', [], perfect);
    expect(v.pass).toBe(false);
    expect(v.total).toBe(0);
  });

  it('ignores trailing whitespace differences by default', async () => {
    const padded: ToolRunner = async (_n, args) => ({
      ok: true,
      output: `hit-${String(args.pattern)}  \n`,
    });
    expect((await replayTool('grep_hit', fixtures, padded)).pass).toBe(true);
    const strict = await replayTool('grep_hit', fixtures, padded, { normalize: false });
    expect(strict.pass).toBe(false);
  });

  describe('fixtures 与工具同目录存放（永久回归）', () => {
    it('round-trips through tools/<name>/tests.jsonl', () => {
      writeFixtures(root, 'grep_hit', fixtures);
      expect(fs.existsSync(path.join(root, 'tools', 'grep_hit', 'tests.jsonl'))).toBe(true);
      expect(readFixtures(root, 'grep_hit')).toEqual(fixtures);
    });

    it('returns an empty list when a tool has no fixtures', () => {
      expect(readFixtures(root, 'nope')).toEqual([]);
    });
  });

  describe('validateAcceptFixtures (M5a)', () => {
    it('rejects an empty set', () => {
      expect(validateAcceptFixtures([]).join()).toMatch(/empty fixtures/);
    });

    it('rejects fixtures without provenance', () => {
      const errs = validateAcceptFixtures([{ args: {}, expected: 'x' }]);
      expect(errs.join()).toMatch(/provenance/);
    });

    it('rejects candidate_self provenance — that is the self-referential gate', () => {
      const errs = validateAcceptFixtures([
        {
          args: {},
          expected: 'x',
          provenance: { kind: 'candidate_self' } as ReplayFixture['provenance'],
        },
      ]);
      expect(errs.join()).toMatch(/self-referential|candidate_self/);
    });

    it('accepts original_replay and external', () => {
      expect(
        validateAcceptFixtures([
          { args: {}, expected: 'a', provenance: { kind: 'original_replay' } },
          { args: {}, expected: 'b', provenance: { kind: 'external', note: 'oracle' } },
        ]),
      ).toEqual([]);
    });
  });

  describe('buildFixturesFromOriginal (M5a)', () => {
    it('tags every fixture as original_replay and skips null effects', async () => {
      const built = await buildFixturesFromOriginal({
        bindings: [{ f: 'a' }, { f: 'b' }, { f: 'c' }],
        originalEffect: async (_i, args) => (args.f === 'b' ? null : `effect-${args.f}`),
      });
      expect(built).toEqual([
        { args: { f: 'a' }, expected: 'effect-a', provenance: { kind: 'original_replay' } },
        { args: { f: 'c' }, expected: 'effect-c', provenance: { kind: 'original_replay' } },
      ]);
      expect(validateAcceptFixtures(built)).toEqual([]);
    });
  });

  describe('effect digests (M5b)', () => {
    it('summarises an artifact by line count and content hash', () => {
      const d = artifactEffectDigest('aa\nbb\n', 'out.csv');
      expect(d).toMatch(/^artifact=out\.csv lines=2 sha=/);
      // same content ⇒ same digest; different content ⇒ different
      expect(artifactEffectDigest('aa\nbb\n')).toBe(d);
      expect(artifactEffectDigest('aa\ncc\n')).not.toBe(d);
    });

    it('serialises a fact set stably (order-independent, deduped)', () => {
      expect(factsEffectDigest(['b=2', 'a=1', 'b=2'])).toBe('facts=a=1|b=2');
      expect(factsEffectDigest([])).toBe('');
    });

    it('composes non-empty parts and drops empties', () => {
      expect(composeEffectDigest(artifactEffectDigest('x\n'), '', factsEffectDigest(['k=v']))).toBe(
        `${artifactEffectDigest('x\n')} facts=k=v`,
      );
      expect(composeEffectDigest('', null, undefined)).toBe('');
    });
  });
});
