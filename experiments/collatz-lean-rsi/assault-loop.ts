/**
 * Collatz proof assault — **task goal = prove 3n+1** (`Collatz.conjecture` without sorry).
 * RSI is an orthogonal sidecar (H13): only runs when the loop tooling is broken.
 *
 * ADL: doc/structurizr/COLLATZ-LEAN-RSI.md
 *
 * Usage (repo root):
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   export PATH="$HOME/.elan/toolchains/leanprover--lean4---v4.14.0/bin:$HOME/tools/node/bin:$PATH"
 *   npx --yes tsx experiments/collatz-lean-rsi/assault-loop.ts --rounds=5
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { writeRunContext } from '../../packages/server/src/openkuroneko/inner-brain/run-context-store.ts';
import { maybeApplyHarnessRsiCycle } from '../../packages/server/src/openkuroneko/inner-brain/harness-rsi-cycle.ts';
import { createHarnessSpecStore } from '../../packages/server/src/openkuroneko/inner-brain/harness-spec-store.ts';
import { createHarnessPointer } from '../../packages/server/src/openkuroneko/inner-brain/harness-pointer.ts';
import { createNodeSkillStore } from '../../packages/server/src/openkuroneko/inner-brain/node-skill-store.ts';
import {
  collectHarnessFindings,
  readAnalyzeCadence,
} from '../../packages/server/src/openkuroneko/inner-brain/harness-analyze.ts';
import { createHarnessLoopTreeStore } from '../../packages/server/src/openkuroneko/inner-brain/harness-loop-tree.ts';
import {
  collectProofStallSignals,
  proposeLoopPatches,
} from '../../packages/server/src/openkuroneko/inner-brain/harness-loop-patch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = here;
const repoRoot = path.resolve(here, '../..');
const LEAN_NODE = 'local/lean-build';
const EXPL = path.join(workDir, 'Collatz', 'Exploration.lean');
const CONJ = path.join(workDir, 'Collatz', 'Conjecture.lean');
const PLAN = path.join(workDir, 'ProofPlan.md');
const JOURNAL = path.join(workDir, '.brain', 'proof-journal.jsonl');
const LAST_REJECTED = path.join(workDir, '.brain', 'last-rejected-lean.log');
const LOOP_META = 'loop-meta.ts';
const LOOP_META_ABS = path.join(workDir, LOOP_META);

const LEAN_TC_BIN = path.join(
  process.env.HOME ?? '',
  '.elan/toolchains/leanprover--lean4---v4.14.0/bin',
);
if (fs.existsSync(path.join(LEAN_TC_BIN, 'lake'))) {
  process.env.PATH = `${LEAN_TC_BIN}${path.delimiter}${process.env.PATH ?? ''}`;
}

function loadEnvFile(p: string): void {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function argNum(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function lakeBuild(): { ok: boolean; log: string; exitCode: number } {
  const r = spawnSync('lake', ['build'], {
    cwd: workDir,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return { ok: (r.status ?? 1) === 0, log, exitCode: r.status ?? 1 };
}

function writeStamp(ok: boolean, detail: string): void {
  const stamp = path.join(workDir, '.brain', 'lean-build.ok');
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  if (ok) fs.writeFileSync(stamp, `${new Date().toISOString()}\n`, 'utf8');
  else if (fs.existsSync(stamp)) fs.unlinkSync(stamp);
  fs.writeFileSync(
    path.join(workDir, '.brain', 'lean-last-build.json'),
    JSON.stringify({ ok, detail: detail.slice(0, 6000), at: new Date().toISOString() }, null, 2),
  );
}

function hashText(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function conjectureHasSorry(src: string): boolean {
  // Any tactic-level sorry in the goal file means the proof is still open.
  const stripped = src
    .replace(/\/-!?[\s\S]*?-\//g, '')
    .replace(/--[^\n]*/g, '');
  return /\bsorry\b/.test(stripped);
}

function ensureSeed(): void {
  fs.mkdirSync(path.join(workDir, '.brain', 'harness', 'fixtures'), { recursive: true });
  const gate = path.join(workDir, '.brain', 'harness', 'fixtures', 'gate.json');
  if (!fs.existsSync(gate)) {
    fs.writeFileSync(
      gate,
      JSON.stringify(
        {
          expects: [
            { fileExists: 'Collatz/Conjecture.lean' },
            { fileExists: 'Collatz/Exploration.lean' },
            { fileExists: 'ProofPlan.md' },
            { fileExists: '.brain/lean-build.ok' },
          ],
        },
        null,
        2,
      ),
    );
  }
  if (!fs.existsSync(LOOP_META_ABS)) {
    fs.writeFileSync(
      LOOP_META_ABS,
      `/** Loop entry pointer only — not a proof metric (H13). */\nexport const assaultEpoch = 0;\n`,
      'utf8',
    );
  }
  if (!fs.existsSync(PLAN)) {
    throw new Error('ProofPlan.md missing — required for prove-collatz goal');
  }
  const skills = createNodeSkillStore(workDir);
  if (skills.readIndex(LEAN_NODE).length === 0) {
    skills.writeSkill(LEAN_NODE, {
      category: 'lean',
      title: 'Prove Collatz (3n+1)',
      tags: ['collatz', 'prove'],
      content:
        'GOAL: prove Collatz.conjecture with no sorry. Maintain ProofPlan.md. Exploration only for plan-serving lemmas. RSI is separate tooling repair.',
    });
  }

  const trees = createHarnessLoopTreeStore(workDir);
  const seedFiles = [
    { from: LOOP_META, to: LOOP_META },
    { from: 'assault-loop.ts', to: 'assault-loop.ts' },
    { from: 'run-loop.ts', to: 'run-loop.ts' },
  ].filter((f) => fs.existsSync(path.join(workDir, f.from)));
  const tree = trees.seed({ files: seedFiles });

  const store = createHarnessSpecStore(workDir);
  const ptr = createHarnessPointer(workDir, store);
  const active = ptr.readActive();
  const activeSpec = active ? store.get(active.harnessId) : null;
  if (!activeSpec?.refs.loopTreeId) {
    const spec = store.put({
      id: activeSpec ? undefined : 'hs-collatz-seed',
      parentId: activeSpec?.id,
      refs: {
        localNodeIds: [LEAN_NODE],
        assetPaths: [
          'Collatz/Conjecture.lean',
          'Collatz/Exploration.lean',
          'ProofPlan.md',
          '.brain/lean-build.ok',
        ],
        loopTreeId: tree.treeId,
        loopRoots: [''],
        loopEntry: LOOP_META,
        gateChecks: [{ id: 'loop-meta-exists', command: `test -f "${LOOP_META}"` }],
      },
      status: 'gated_ok',
    });
    ptr.upgrade(spec.id);
  }
}

function extractFence(text: string, name: string): string | null {
  const re = new RegExp('```' + name + '\\s*([\\s\\S]*?)```', 'i');
  const m = text.match(re);
  return m ? m[1]!.trim() : null;
}

/** Append plan-serving Exploration theorems only (no decide-enumeration spam). */
function mergeExploration(current: string, addition: string): string {
  let add = addition.trim();
  add = add
    .replace(/^import\s+Collatz\.Conjecture\s*/m, '')
    .replace(/^namespace\s+Collatz\.Exploration\s*/m, '')
    .replace(/^end\s+Collatz\.Exploration\s*/m, '')
    .replace(/\/--\s*assault append\s*--\/\s*/gi, '')
    .trim();
  if (!add) throw new Error('empty exploration addition');
  // Ban bulk concrete ReachesOne N via decide — that is not a proof strategy
  if (/\breaches_\d+\b/.test(add) && /\bdecide\b/.test(add)) {
    throw new Error('rejected: decide-enumeration of reaches_N is not proof progress');
  }
  if (/\bstep_\d+\b/.test(add) && /\bdecide\b/.test(add) && !/\b(∀|forall|→|->)\b/.test(add)) {
    throw new Error('rejected: concrete step_N decide facts without generality');
  }
  if (!/\btheorem\b|\blemma\b/.test(add)) throw new Error('exploration addition has no theorem/lemma');
  const existing = new Set(
    [...current.matchAll(/\b(?:theorem|lemma)\s+([A-Za-z0-9_']+)/g)].map((m) => m[1]!),
  );
  const kept: string[] = [];
  for (const block of add.split(/(?=^\s*(?:theorem|lemma)\s+)/m)) {
    const t = block.trim();
    if (!t) continue;
    const name = t.match(/^\s*(?:theorem|lemma)\s+([A-Za-z0-9_']+)/)?.[1];
    if (name && existing.has(name)) continue;
    if (name) existing.add(name);
    kept.push(t);
  }
  if (kept.length === 0) throw new Error('no new plan-serving lemmas');
  const marker = 'end Collatz.Exploration';
  const idx = current.lastIndexOf(marker);
  if (idx < 0) throw new Error('Exploration.lean missing end marker');
  return `${current.slice(0, idx).trimEnd()}\n\n/-- plan lemma --/\n${kept.join('\n')}\n\n${marker}\n`;
}

interface ProofProposal {
  plan?: string;
  explorationAdd?: string;
  conjecture?: string;
  raw: string;
}

async function zhipuProve(
  plan: string,
  conjecture: string,
  exploration: string,
  lastLog: string,
): Promise<ProofProposal> {
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) throw new Error('ZHIPU_API_KEY missing');
  const baseUrl = (process.env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4').replace(
    /\/$/,
    '',
  );
  const model = process.env.ZHIPU_MODEL ?? 'glm-5.1';
  const maxTokens = Math.min(8192, Math.max(1024, Number(process.env.ZHIPU_MAX_TOKENS ?? 4096)));

  const system = [
    'You are a mathematician-engineer whose ONLY task goal is to PROVE the Collatz (3n+1) conjecture in Lean 4.14.',
    'NO mathlib — do not use Nat.even_or_odd, Mathlib.*, or any import beyond this project.',
    'Target: remove every `sorry` from Collatz/Conjecture.lean — especially prove `odd_descent`.',
    'Harness-RSI / lake green / lemma counts are NOT success. Finite ReachesOne n facts are NOT a proof.',
    'Each turn you MUST advance the proof strategy:',
    '1) ALWAYS emit ```proofplan``` — concrete approach + open subgoals that block removing sorry.',
    '2) Focus on proving `odd_descent` (or a correct lemma that implies it). Even/1 cases are already done.',
    '3) Optionally rewrite Collatz/Conjecture.lean; keep structure if it still helps.',
    'Lean craft notes:',
    '- NO mathlib. Use omega for parity/`n=2*(n/2)`.',
    '- For odd step: prove `(2*k+1)%2=1` with omega, then `simp [step, h]`.',
    '- Prefer small correct lemmas over a giant induction that does not typecheck.',
    'Allowed: simp, rfl, refine, intro, cases, induction, have, exact, omega.',
    'Forbidden as progress: reaches_N/step_N via decide; claiming victory because lake builds; mixing RSI into the goal.',
    'Output fences (include only what you change; proofplan is required every turn):',
    '```proofplan',
    '```lean-exploration',
    '```lean-conjecture',
    'You may keep sorry temporarily IF ProofPlan lists the exact blocker subgoal.',
  ].join('\n');

  const user = [
    '## ProofPlan.md',
    '```md',
    plan.slice(0, 6000),
    '```',
    '',
    '## Collatz/Conjecture.lean',
    '```lean',
    conjecture.slice(0, 12000),
    '```',
    '',
    '## Collatz/Exploration.lean (excerpt)',
    '```lean',
    exploration.slice(0, 3500),
    '```',
    '',
    '## Last lake errors / rejected Lean (H14: do not drop this after a green rebuild)',
    '```',
    lastLog.slice(-2500),
    '```',
    '',
    'Advance the proof of 3n+1. Primary blocker: prove `odd_descent` (remove its sorry).',
  ].join('\n');

  const ZHIPU_EMPTY_RETRY = 1;
  let text = '';
  let lastHttp = '';
  for (let attempt = 0; attempt <= ZHIPU_EMPTY_RETRY; attempt++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: attempt === 0 ? 0.25 : 0.4,
        thinking: { type: process.env.ZHIPU_THINKING === 'enabled' ? 'enabled' : 'disabled' },
      }),
    });
    const raw = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    if (!res.ok) {
      lastHttp = `ZHIPU HTTP ${res.status}: ${raw.error?.message ?? res.statusText}`;
      continue;
    }
    const content = raw.choices?.[0]?.message?.content;
    text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p) => p?.text ?? '').join('')
          : '';
    if (text.trim()) break;
  }
  if (!text.trim()) throw new Error(lastHttp || 'empty ZHIPU content');
  return {
    raw: text.trim(),
    ...(extractFence(text, 'proofplan') ? { plan: extractFence(text, 'proofplan')! } : {}),
    ...(extractFence(text, 'lean-exploration')
      ? { explorationAdd: extractFence(text, 'lean-exploration')! }
      : {}),
    ...(extractFence(text, 'lean-conjecture')
      ? { conjecture: extractFence(text, 'lean-conjecture')! }
      : {}),
  };
}

function appendJournal(row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

async function main(): Promise<void> {
  loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));
  loadEnvFile(path.join(repoRoot, '.env'));
  const rounds = argNum('rounds', 5);
  const interval = argNum('interval', 1);
  ensureSeed();

    let lastLog = fs.existsSync(LAST_REJECTED) ? fs.readFileSync(LAST_REJECTED, 'utf8') : '';
  console.log(
    `[prove-collatz] goal=prove Collatz.conjecture (no sorry) | RSI=sidecar only | rounds=${rounds}`,
  );

  for (let i = 1; i <= rounds; i++) {
    console.log(`\n══ proof round ${i}/${rounds} ══`);
    const planBefore = fs.readFileSync(PLAN, 'utf8');
    const conjBefore = fs.readFileSync(CONJ, 'utf8');
    const explBefore = fs.readFileSync(EXPL, 'utf8');
    const sorryBefore = conjectureHasSorry(conjBefore);

    let proposal: ProofProposal;
    try {
      proposal = await zhipuProve(planBefore, conjBefore, explBefore, lastLog);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[proof] propose failed:', msg.slice(0, 240));
      appendJournal({ round: i, track: 'proof', ok: false, stage: 'propose', error: msg.slice(0, 500) });
      // RSI sidecar still may run on tooling fail signals
      runRsiSidecar(false, lastLog, interval, i);
      continue;
    }

    if (!proposal.plan && !proposal.explorationAdd && !proposal.conjecture) {
      console.warn('[proof] empty proposal (no fences) — no proof progress');
      appendJournal({ round: i, track: 'proof', ok: false, stage: 'empty_proposal' });
      runRsiSidecar(true, lastLog, interval, i);
      continue;
    }

    // Apply proposal in layers: plan always; each Lean file gated on its own lake build
    if (proposal.plan) {
      fs.writeFileSync(PLAN, proposal.plan.endsWith('\n') ? proposal.plan : `${proposal.plan}\n`, 'utf8');
    }

    let explKept = false;
    let rejectLog = '';
    if (proposal.explorationAdd) {
      try {
        fs.writeFileSync(EXPL, mergeExploration(explBefore, proposal.explorationAdd), 'utf8');
        const b = lakeBuild();
        if (b.ok) {
          explKept = true;
          lastLog = b.log;
          writeStamp(true, b.log);
          console.log('[proof] exploration lemmas kept');
        } else {
          lastLog = b.log;
          rejectLog = rejectLog || b.log;
          fs.writeFileSync(EXPL, explBefore, 'utf8');
          console.warn('[proof] exploration rejected by lake — reverted');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[proof] exploration rejected:', msg);
        fs.writeFileSync(EXPL, explBefore, 'utf8');
      }
    }

    let conjKept = false;
    if (proposal.conjecture) {
      fs.writeFileSync(CONJ, proposal.conjecture.endsWith('\n') ? proposal.conjecture : `${proposal.conjecture}\n`, 'utf8');
      const b = lakeBuild();
      lastLog = b.log;
      if (b.ok) {
        conjKept = true;
        writeStamp(true, b.log);
        console.log('[proof] conjecture update kept');
      } else {
        rejectLog = b.log;
        fs.writeFileSync(CONJ, conjBefore, 'utf8');
        writeStamp(false, b.log);
        console.warn('[proof] conjecture rejected by lake — reverted (ProofPlan kept)');
      }
    }

    // Ensure stamp reflects current tree
    const finalBuild = lakeBuild();
    // H14_KEEP_REJECT_LOG: green rebuild must not hide rejected Lean.
    lastLog = rejectLog || finalBuild.log || lastLog;
    if (rejectLog) {
      fs.mkdirSync(path.dirname(LAST_REJECTED), { recursive: true });
      fs.writeFileSync(LAST_REJECTED, rejectLog, 'utf8');
    }
    writeStamp(finalBuild.ok, lastLog);
    console.log(`[lake build] exit=${finalBuild.exitCode} ok=${finalBuild.ok}`);

    const leanKept = finalBuild.ok;
    const conjAfter = fs.readFileSync(CONJ, 'utf8');
    const planAfter = fs.readFileSync(PLAN, 'utf8');
    const explAfter = fs.readFileSync(EXPL, 'utf8');
    const sorryAfter = conjectureHasSorry(conjAfter);
    const proved = leanKept && !sorryAfter;
    const proofProgress = {
      lakeOk: leanKept,
      conjectureSorry: sorryAfter,
      sorryCleared: conjKept && sorryBefore && !sorryAfter,
      planChanged: hashText(planBefore) !== hashText(planAfter),
      conjectureChanged: conjKept && hashText(conjBefore) !== hashText(conjAfter),
      explorationChanged: explKept && hashText(explBefore) !== hashText(explAfter),
      proved,
    };
    console.log('[proof.progress]', proofProgress);

    writeRunContext(workDir, {
      burstId: `prove-r${i}`,
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: leanKept,
      ...(leanKept ? {} : { failedAt: 'lake-build' }),
      nodes: [
        {
          nodeInstId: 'lean-build',
          ref: LEAN_NODE,
          ok: leanKept,
          entries: [
            {
              toolName: 'prove_collatz',
              args: { round: i },
              result: { ok: proved, output: JSON.stringify(proofProgress).slice(0, 800) },
            },
            {
              toolName: 'lake_build',
              args: { command: 'lake build' },
              result: { ok: leanKept, output: lastLog.slice(0, 1200) },
            },
          ],
        },
      ],
      results: [],
    });

    appendJournal({ round: i, track: 'proof', ...proofProgress });

    // Orthogonal RSI sidecar — must not be read as proof success
    const rsi = runRsiSidecar(leanKept, lastLog, interval, i);
    console.log('[rsi.sidecar]', rsi);

    if (proved) {
      console.log('\n[prove-collatz] SUCCESS: conjecture has no sorry and lake is green');
      break;
    }
  }

  const finalSorry = conjectureHasSorry(fs.readFileSync(CONJ, 'utf8'));
  console.log(
    `\n[prove-collatz] done — conjectureSorry=${finalSorry} journal=${JOURNAL}`,
  );
}

function runRsiSidecar(
  runOk: boolean,
  lastLog: string,
  interval: number,
  round: number,
): unknown {
  const findings = collectHarnessFindings(workDir, runOk);
  const activeBefore = createHarnessPointer(workDir).readActive();
  const refsBefore = activeBefore
    ? createHarnessSpecStore(workDir).get(activeBefore.harnessId)?.refs
    : undefined;
  const stall = collectProofStallSignals(workDir);
  const proposal =
    refsBefore?.loopTreeId != null
      ? proposeLoopPatches({
          workDir,
          findings,
          loopTreeId: refsBefore.loopTreeId,
          signals: [
            lastLog,
            runOk ? '' : 'lake_build_failed',
            stall.summary,
            stall.spinning ? 'h14_proof_stall' : '',
          ],
        })
      : null;
  if (proposal) console.log('[rsi] loop repair:', proposal.rationale);
  const rsi = maybeApplyHarnessRsiCycle(workDir, {
    runOk,
    rsiRound: 0,
    analyzeInterval: interval,
    ...(proposal?.patches.length ? { patches: proposal.patches, forceAnalyze: true } : {}),
  });
  appendJournal({
    round,
    track: 'rsi',
    repair: proposal?.addresses ?? null,
    rsi,
    cadence: readAnalyzeCadence(workDir).attributeCount,
    note: 'orthogonal_to_proof_goal',
  });
  return rsi;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
