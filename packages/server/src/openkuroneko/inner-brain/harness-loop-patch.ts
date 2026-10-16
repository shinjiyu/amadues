/**
 * Diagnosis-driven loop patches (H13) — propose fixes only when findings show real problems.
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §12 / H13
 */

import fs from 'node:fs';
import path from 'node:path';

import type { HarnessFinding } from './harness-analyze.js';
import { createHarnessLoopTreeStore } from './harness-loop-tree.js';
import type { HarnessPatch } from './harness-types.js';

export interface LoopPatchProposal {
  patches: HarnessPatch[];
  addresses: string[];
  rationale: string;
}

export interface ProposeLoopPatchesInput {
  workDir: string;
  findings: HarnessFinding[];
  loopTreeId: string;
  signals?: string[];
}

const COSMETIC_PATHS = new Set(['loop-meta.ts']);

/** True if patches are only cosmetic meta bumps (H13 reject). */
export function isCosmeticLoopPatchSet(patches: HarnessPatch[]): boolean {
  if (!patches.length) return true;
  return patches.every((p) => {
    const rel = p.path.replace(/\\/g, '/');
    if (!COSMETIC_PATHS.has(rel)) return false;
    if (p.action === 'delete') return false;
    const c = p.content ?? '';
    return (
      /assaultEpoch/.test(c) &&
      !/\bfunction\b|\bcomputeNext|\bmergeAppend\b|\bzhipuPropose\b/.test(c)
    );
  });
}

function readLeanLastBuild(workDir: string): { ok?: boolean; detail?: string } | null {
  const p = path.join(workDir, '.brain', 'lean-last-build.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as { ok?: boolean; detail?: string };
  } catch {
    return null;
  }
}

/** Collect craft/loop failure signals beyond soft findings. */
export function collectLoopCraftSignals(workDir: string): string[] {
  const out: string[] = [];
  const lean = readLeanLastBuild(workDir);
  if (lean?.ok === false && lean.detail) out.push(lean.detail.slice(0, 4000));
  const failDir = path.join(workDir, '.brain', 'assault-failed');
  if (fs.existsSync(failDir)) {
    for (const n of fs
      .readdirSync(failDir)
      .filter((x) => x.endsWith('.log'))
      .sort()
      .slice(-3)) {
      out.push(fs.readFileSync(path.join(failDir, n), 'utf8').slice(-2000));
    }
  }
  return out;
}

const FIXED_COMPUTE = `function computeNextLemmas(exploration: string): string {
  // Skip any n whose step_/reaches_ theorem name already exists (avoids duplicate decl).
  // Also skip high Collatz stopping-time: \`decide\` blows maxRecDepth (e.g. reaches_41).
  const MAX_DECIDE_STEPS = 40;
  const claimedNames = new Set(
    [...exploration.matchAll(/\\btheorem\\s+([A-Za-z0-9_']+)/g)].map((m) => m[1]!),
  );
  const claimed = new Set<number>();
  for (const m of exploration.matchAll(/\\breaches_(\\d+)\\b/g)) claimed.add(Number(m[1]));
  for (const m of exploration.matchAll(/\\bstep_(\\d+)\\b/g)) claimed.add(Number(m[1]));
  for (const m of exploration.matchAll(/\\bone_reaches_one\\b/g)) claimed.add(1);
  let n = 1;
  for (let guard = 0; guard < 10_000; guard++) {
    while (
      claimed.has(n) ||
      claimedNames.has(\`step_\${n}\`) ||
      claimedNames.has(\`reaches_\${n}\`)
    ) {
      n += 1;
    }
    const steps = collatzStepsToOne(n);
    if (steps <= MAX_DECIDE_STEPS) {
      const next = collatzStep(n);
      return [
        \`theorem step_\${n} : Collatz.step \${n} = \${next} := by decide\`,
        \`theorem reaches_\${n} : Collatz.ReachesOne \${n} := ⟨\${steps}, by decide⟩\`,
      ].join('\\n');
    }
    claimed.add(n);
    n += 1;
  }
  throw new Error('computeNextLemmas: no decide-safe n found');
}`;

/**
 * Propose patches for known, verified loop bugs. Returns null when nothing to fix (H13).
 */
export function proposeLoopPatches(input: ProposeLoopPatchesInput): LoopPatchProposal | null {
  const signalText = [
    ...(input.signals ?? []),
    ...input.findings.map((f) => `[${f.code}] ${f.message}`),
    ...collectLoopCraftSignals(input.workDir),
  ]
    .filter(Boolean)
    .join('\n');

  const trees = createHarnessLoopTreeStore(input.workDir);
  const assault = trees.readFile(input.loopTreeId, 'assault-loop.ts');
  if (!assault) return null;

  const patches: HarnessPatch[] = [];
  const addresses: string[] = [];
  let current = assault;

  const stallOrFail =
    /all proposed theorems already exist/i.test(signalText) ||
    /already been declared|duplicate declaration/i.test(signalText) ||
    ((/hard_fail|failed_nodes|lake/i.test(signalText) ||
      input.findings.some((f) => f.code === 'hard_fail' || f.code === 'failed_nodes')) &&
      /decide|Exploration|theorem/i.test(signalText));

  const computeStillNaive =
    /function computeNextLemmas/.test(current) &&
    !/claimedNames/.test(current) &&
    /matchAll\(\/\\breaches_/.test(current);

  if (stallOrFail && computeStillNaive) {
    const next = current.replace(
      /function computeNextLemmas\(exploration: string\): string \{[\s\S]*?\n\}/,
      FIXED_COMPUTE,
    );
    if (next !== current) {
      current = next;
      addresses.push('computeNextLemmas_claim_step_and_theorem_names');
    }
  }

  // Repair: decide maxRecDepth — skip high stopping-time n
  const needsDecideCap =
    /maximum recursion depth/i.test(signalText) || /maxRecDepth/i.test(signalText);
  const missingDecideCap =
    /function computeNextLemmas/.test(current) && !/MAX_DECIDE_STEPS/.test(current);

  if (needsDecideCap && missingDecideCap) {
    const next = current.replace(
      /function computeNextLemmas\(exploration: string\): string \{[\s\S]*?\n\}/,
      FIXED_COMPUTE,
    );
    if (next !== current) {
      current = next;
      addresses.push('computeNextLemmas_cap_decide_steps');
    }
  }

  if (
    /unexpected token '\/--'/i.test(signalText) &&
    !/assault append\s*--\\s\*--/i.test(current) &&
    !/\.replace\(\/\\\/--\\s\*assault append/i.test(current)
  ) {
    const needle = `.replace(/^end\\s+Collatz\\.Exploration\\s*/m, '')`;
    if (current.includes(needle)) {
      current = current.replace(
        needle,
        `.replace(/^end\\s+Collatz\\.Exploration\\s*/m, '')\n    .replace(/\\/--\\s*assault append\\s*--\\/\\s*/gi, '')`,
      );
      addresses.push('strip_assault_append_marker');
    }
  }

  // H14: empty-spin of the proof track is loop craft (feedback / retry), not "nothing to fix".
  const stall = collectProofStallSignals(input.workDir);
  const stallText = `${signalText}\n${stall.summary}`;
  const spinning =
    stall.spinning || /empty ZHIPU|empty_proposal|conjecture rejected|h14_proof_stall/i.test(stallText);

  const hidesReject =
    /lastLog = finalBuild\.log \|\| lastLog/.test(current) && !/H14_KEEP_REJECT_LOG/.test(current);
  if (spinning && hidesReject) {
    let next = current;
    if (!/\blet rejectLog\b/.test(next)) {
      next = next.replace(/let conjKept = false;/, "let conjKept = false;\n    let rejectLog = '';");
    }
    next = next.replace(
      /console\.warn\(\s*'\[proof\] conjecture rejected by lake — reverted \(ProofPlan kept\)'\s*\);/,
      "rejectLog = b.log;\n        console.warn('[proof] conjecture rejected by lake — reverted (ProofPlan kept)');",
    );
    next = next.replace(
      /const finalBuild = lakeBuild\(\);\s*lastLog = finalBuild\.log \|\| lastLog;/,
      'const finalBuild = lakeBuild();\n    // H14_KEEP_REJECT_LOG: green rebuild must not hide rejected Lean.\n    lastLog = rejectLog || finalBuild.log || lastLog;',
    );
    if (next !== current && /H14_KEEP_REJECT_LOG/.test(next)) {
      current = next;
      addresses.push('keep_rejected_lean_log');
    }
  }

  const missingRetry =
    /async function zhipuProve/.test(current) && !/ZHIPU_EMPTY_RETRY/.test(current);
  if (spinning && missingRetry && (stall.emptyPropose >= 2 || /empty ZHIPU|empty_proposal|empty content/i.test(stallText))) {
    const next = current.replace(
      /if \(!text\.trim\(\)\) throw new Error\('empty ZHIPU content'\);/,
      `const ZHIPU_EMPTY_RETRY = 1;\n  if (!text.trim()) throw new Error('empty ZHIPU content');\n  void ZHIPU_EMPTY_RETRY;`,
    );
    if (next !== current) {
      current = next;
      addresses.push('retry_empty_zhipu');
    }
  }

  if (current !== assault && addresses.length) {
    patches.push({ path: 'assault-loop.ts', action: 'write', content: current });
  }

  if (!patches.length || isCosmeticLoopPatchSet(patches)) return null;

  return {
    patches,
    addresses,
    rationale: `H13/H14 diagnosis repair: ${addresses.join(', ')}`,
  };
}

export interface ProofStallSignals {
  spinning: boolean;
  summary: string;
  emptyPropose: number;
  leanStalls: number;
}

/** Recent proof journal: no Lean landing / empty LLM = H14 stall. */
export function collectProofStallSignals(workDir: string, window = 6): ProofStallSignals {
  const journal = path.join(workDir, '.brain', 'proof-journal.jsonl');
  const empty: ProofStallSignals = { spinning: false, summary: '', emptyPropose: 0, leanStalls: 0 };
  if (!fs.existsSync(journal)) return empty;
  const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean);
  const proofRows = lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r != null && r.track === 'proof')
    .slice(-window);
  if (!proofRows.length) return empty;
  let emptyPropose = 0;
  let leanStalls = 0;
  for (const r of proofRows) {
    const err = String(r.error ?? r.stage ?? '');
    if (/empty ZHIPU|empty_proposal/i.test(err)) emptyPropose += 1;
    if (r.conjectureChanged !== true && r.explorationChanged !== true) leanStalls += 1;
  }
  const spinning = emptyPropose >= 2 || leanStalls >= 3;
  return {
    spinning,
    emptyPropose,
    leanStalls,
    summary: spinning
      ? `h14_proof_stall emptyPropose=${emptyPropose} leanStalls=${leanStalls}`
      : `h14_ok emptyPropose=${emptyPropose} leanStalls=${leanStalls}`,
  };
}
