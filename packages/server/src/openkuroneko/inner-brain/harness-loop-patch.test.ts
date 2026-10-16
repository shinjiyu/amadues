import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isCosmeticLoopPatchSet,
  proposeLoopPatches,
} from './harness-loop-patch.js';
import { createHarnessLoopTreeStore } from './harness-loop-tree.js';

describe('harnessLoopPatch', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lp-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects cosmetic epoch-only patches (H13)', () => {
    expect(
      isCosmeticLoopPatchSet([
        {
          path: 'loop-meta.ts',
          action: 'write',
          content: 'export const assaultEpoch = 9;\n',
        },
      ]),
    ).toBe(true);
    expect(
      isCosmeticLoopPatchSet([
        {
          path: 'assault-loop.ts',
          action: 'write',
          content: 'export function computeNextLemmas() {}\n',
        },
      ]),
    ).toBe(false);
  });

  it('proposes computeNextLemmas repair only when stall signal + naive source', () => {
    const naive = `
function computeNextLemmas(exploration: string): string {
  const claimed = new Set<number>();
  for (const m of exploration.matchAll(/\\breaches_(\\d+)\\b/g)) claimed.add(Number(m[1]));
  for (const m of exploration.matchAll(/\\bone_reaches_one\\b/g)) claimed.add(1);
  let n = 1;
  while (claimed.has(n)) n += 1;
  return \`theorem reaches_\${n}\`;
}
`;
    fs.writeFileSync(path.join(root, 'assault-loop.ts'), naive);
    const trees = createHarnessLoopTreeStore(root);
    const t0 = trees.seed({ files: [{ from: 'assault-loop.ts', to: 'assault-loop.ts' }] });

    expect(
      proposeLoopPatches({
        workDir: root,
        findings: [],
        loopTreeId: t0.treeId,
        signals: ['all clear'],
      }),
    ).toBeNull();

    const proposal = proposeLoopPatches({
      workDir: root,
      findings: [{ code: 'hard_fail', severity: 'warn', message: 'lake failed' }],
      loopTreeId: t0.treeId,
      signals: ['all proposed theorems already exist'],
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.addresses).toContain('computeNextLemmas_claim_step_and_theorem_names');
    expect(proposal!.patches[0]!.content).toContain('claimedNames');
  });

  it('returns null when source already has decide cap', () => {
    const fixed = `
function computeNextLemmas(exploration: string): string {
  const MAX_DECIDE_STEPS = 40;
  const claimedNames = new Set();
  return 'x';
}
`;
    fs.writeFileSync(path.join(root, 'assault-loop.ts'), fixed);
    const trees = createHarnessLoopTreeStore(root);
    const t0 = trees.seed({ files: [{ from: 'assault-loop.ts', to: 'assault-loop.ts' }] });
    expect(
      proposeLoopPatches({
        workDir: root,
        findings: [{ code: 'hard_fail', severity: 'warn', message: 'x' }],
        loopTreeId: t0.treeId,
        signals: ['maximum recursion depth has been reached'],
      }),
    ).toBeNull();
  });

  it('H14: stall journal + hidden reject log proposes keep_rejected_lean_log', () => {
    const src = `
let conjKept = false;
if (proposal.conjecture) {
  const b = { ok: false, log: 'unsolved goals' };
  if (!b.ok) {
        console.warn('[proof] conjecture rejected by lake — reverted (ProofPlan kept)');
  }
}
const finalBuild = lakeBuild();
    lastLog = finalBuild.log || lastLog;
async function zhipuProve() {
  let text = 'ok';
  if (!text.trim()) throw new Error('empty ZHIPU content');
}
`;
    fs.writeFileSync(path.join(root, 'assault-loop.ts'), src);
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
    const rows = Array.from({ length: 4 }, (_, i) =>
      JSON.stringify({
        round: i + 1,
        track: 'proof',
        conjectureChanged: false,
        explorationChanged: false,
        planChanged: true,
      }),
    );
    fs.writeFileSync(path.join(root, '.brain', 'proof-journal.jsonl'), `${rows.join('\n')}\n`);
    const trees = createHarnessLoopTreeStore(root);
    const t0 = trees.seed({ files: [{ from: 'assault-loop.ts', to: 'assault-loop.ts' }] });
    const proposal = proposeLoopPatches({
      workDir: root,
      findings: [],
      loopTreeId: t0.treeId,
      signals: ['lake ok'],
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.addresses).toContain('keep_rejected_lean_log');
    expect(proposal!.patches[0]!.content).toContain('H14_KEEP_REJECT_LOG');
  });

  it('H14: empty ZHIPU stall proposes retry marker', () => {
    const src = `
async function zhipuProve() {
  let text = '';
  if (!text.trim()) throw new Error('empty ZHIPU content');
}
const finalBuild = lakeBuild();
    lastLog = 'green';
`;
    fs.writeFileSync(path.join(root, 'assault-loop.ts'), src);
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
    const rows = [
      JSON.stringify({ round: 1, track: 'proof', stage: 'propose', error: 'empty ZHIPU content' }),
      JSON.stringify({ round: 2, track: 'proof', stage: 'propose', error: 'empty ZHIPU content' }),
    ];
    fs.writeFileSync(path.join(root, '.brain', 'proof-journal.jsonl'), `${rows.join('\n')}\n`);
    const trees = createHarnessLoopTreeStore(root);
    const t0 = trees.seed({ files: [{ from: 'assault-loop.ts', to: 'assault-loop.ts' }] });
    const proposal = proposeLoopPatches({
      workDir: root,
      findings: [],
      loopTreeId: t0.treeId,
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.addresses).toContain('retry_empty_zhipu');
    expect(proposal!.patches[0]!.content).toContain('ZHIPU_EMPTY_RETRY');
  });

  it('H14: already repaired source stays null under stall (no cosmetic)', () => {
    const src = `
let conjKept = false;
let rejectLog = '';
const finalBuild = lakeBuild();
    // H14_KEEP_REJECT_LOG
    lastLog = rejectLog || finalBuild.log || lastLog;
async function zhipuProve() {
  const ZHIPU_EMPTY_RETRY = 1;
  if (!text.trim()) throw new Error('empty ZHIPU content');
}
`;
    fs.writeFileSync(path.join(root, 'assault-loop.ts'), src);
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
    const rows = Array.from({ length: 4 }, (_, i) =>
      JSON.stringify({ round: i, track: 'proof', conjectureChanged: false, explorationChanged: false }),
    );
    fs.writeFileSync(path.join(root, '.brain', 'proof-journal.jsonl'), `${rows.join('\n')}\n`);
    const trees = createHarnessLoopTreeStore(root);
    const t0 = trees.seed({ files: [{ from: 'assault-loop.ts', to: 'assault-loop.ts' }] });
    expect(
      proposeLoopPatches({ workDir: root, findings: [], loopTreeId: t0.treeId }),
    ).toBeNull();
  });

  it('proposes MAX_DECIDE_STEPS when maxRecDepth signal and cap missing', () => {
    const withNames = `
function computeNextLemmas(exploration: string): string {
  const claimedNames = new Set();
  const claimed = new Set<number>();
  for (const m of exploration.matchAll(/\\breaches_(\\d+)\\b/g)) claimed.add(Number(m[1]));
  let n = 1;
  while (claimed.has(n)) n += 1;
  const steps = collatzStepsToOne(n);
  return \`theorem reaches_\${n}\`;
}
`;
    fs.writeFileSync(path.join(root, 'assault-loop.ts'), withNames);
    const trees = createHarnessLoopTreeStore(root);
    const t0 = trees.seed({ files: [{ from: 'assault-loop.ts', to: 'assault-loop.ts' }] });
    const proposal = proposeLoopPatches({
      workDir: root,
      findings: [{ code: 'hard_fail', severity: 'warn', message: 'lake' }],
      loopTreeId: t0.treeId,
      signals: ['maximum recursion depth has been reached'],
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.addresses).toContain('computeNextLemmas_cap_decide_steps');
    expect(proposal!.patches[0]!.content).toContain('MAX_DECIDE_STEPS');
  });
});
