/**
 * Formal Collatz RSI assault — Zhipu proposes Exploration.lean; lake build gates; harness RSI cycles.
 * ADL: doc/structurizr/COLLATZ-LEAN-RSI.md §6 C
 *
 * Usage (repo root):
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   export PATH="$HOME/.elan/toolchains/leanprover--lean4---v4.14.0/bin:$HOME/tools/node/bin:$PATH"
 *   npx --yes tsx experiments/collatz-lean-rsi/assault-loop.ts --rounds=5
 *
 * Does NOT claim to prove 3n+1. Success = compile-clean exploration growth under harness RSI.
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
import { readAnalyzeCadence } from '../../packages/server/src/openkuroneko/inner-brain/harness-analyze.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = here;
const repoRoot = path.resolve(here, '../..');
const LEAN_NODE = 'local/lean-build';
const EXPL = path.join(workDir, 'Collatz', 'Exploration.lean');
const CONJ = path.join(workDir, 'Collatz', 'Conjecture.lean');
const JOURNAL = path.join(workDir, '.brain', 'assault-journal.jsonl');

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
            { fileExists: '.brain/lean-build.ok' },
          ],
        },
        null,
        2,
      ),
    );
  }
  const skills = createNodeSkillStore(workDir);
  if (skills.readIndex(LEAN_NODE).length === 0) {
    skills.writeSkill(LEAN_NODE, {
      category: 'lean',
      title: 'Collatz Lean craft',
      tags: ['collatz', 'lean'],
      content:
        'Keep lake build green. Prefer lemmas in Exploration.lean. Gate=compile not truth.',
    });
  }
  const store = createHarnessSpecStore(workDir);
  const ptr = createHarnessPointer(workDir, store);
  if (!ptr.readActive()) {
    const spec = store.put({
      id: 'hs-collatz-seed',
      refs: {
        localNodeIds: [LEAN_NODE],
        assetPaths: [
          'Collatz/Conjecture.lean',
          'Collatz/Exploration.lean',
          '.brain/lean-build.ok',
        ],
      },
      status: 'gated_ok',
    });
    ptr.upgrade(spec.id);
  }
}

function extractLeanBlock(text: string): string | null {
  const m = text.match(/```lean\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
  if (!m) return null;
  return m[1]!.trim();
}

/** Append-only: keep current Exploration body; insert new theorems before `end`. */
function mergeAppend(current: string, addition: string): string {
  let add = addition.trim();
  // strip wrappers if model returned a full file
  add = add
    .replace(/^import\s+Collatz\.Conjecture\s*/m, '')
    .replace(/^namespace\s+Collatz\.Exploration\s*/m, '')
    .replace(/^end\s+Collatz\.Exploration\s*/m, '')
    .trim();
  if (!add) throw new Error('empty addition');
  // refuse dangerous tactics that usually don't close on Collatz here
  if (/\b(induction|omega|linarith|ring|aesop|sorry)\b/.test(add)) {
    throw new Error('addition uses forbidden tactic (induction/omega/sorry/…)');
  }
  if (!/\btheorem\b/.test(add)) throw new Error('addition has no theorem');
  const marker = 'end Collatz.Exploration';
  const idx = current.lastIndexOf(marker);
  if (idx < 0) throw new Error('Exploration.lean missing end marker');
  return `${current.slice(0, idx).trimEnd()}\n\n/-- assault append --/\n${add}\n\n${marker}\n`;
}

async function zhipuPropose(exploration: string, conjecture: string, lastLog: string): Promise<string> {
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) throw new Error('ZHIPU_API_KEY missing (source deploy/agent/env/collatz-lean.env)');
  const baseUrl = (process.env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4').replace(
    /\/$/,
    '',
  );
  const model = process.env.ZHIPU_MODEL ?? 'glm-5.1';
  const maxTokens = Math.min(4096, Math.max(512, Number(process.env.ZHIPU_MAX_TOKENS ?? 2048)));

  const system = [
    'You formalize tiny Collatz facts in Lean 4.14 (no mathlib).',
    'APPEND-ONLY: output 1–3 NEW theorems to insert into Collatz/Exploration.lean.',
    'Allowed proofs ONLY: `rfl`, `decide`, `simp [Collatz.step]`, `simp [Collatz.iterate]`, or `⟨k, by decide⟩` for ReachesOne.',
    'Forbidden: induction, omega, linarith, ring, aesop, sorry, rewriting Conjecture.lean, claiming full proof.',
    'Prefer concrete Nat facts, e.g. `theorem reaches_8 : Collatz.ReachesOne 8 := ⟨3, by decide⟩`.',
    'Do not repeat existing theorem names.',
    'Wrap the addition in a ```lean fence (theorems only, no import/namespace/end required).',
    'No KPI / x_eval / scoring rubrics.',
  ].join('\n');

  const user = [
    '## Existing Exploration.lean (do not repeat these theorems)',
    '```lean',
    exploration.slice(0, 5000),
    '```',
    '',
    '## Conjecture context (open; may keep sorry)',
    '```lean',
    conjecture.slice(0, 1500),
    '```',
    '',
    '## Last lake build errors (fix any)',
    '```',
    lastLog.slice(-2000),
    '```',
    '',
    'Propose 1–3 NEW small theorems that will typecheck.',
  ].join('\n');

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
      temperature: 0.2,
      thinking: { type: process.env.ZHIPU_THINKING === 'enabled' ? 'enabled' : 'disabled' },
    }),
  });
  const raw = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  if (!res.ok) throw new Error(`ZHIPU HTTP ${res.status}: ${raw.error?.message ?? res.statusText}`);
  const content = raw.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? '').join('')
        : '';
  if (!text.trim()) throw new Error('empty ZHIPU content');
  return text.trim();
}

function appendJournal(row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

function hashFile(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
}

async function main(): Promise<void> {
  loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));
  loadEnvFile(path.join(repoRoot, '.env'));
  const rounds = argNum('rounds', 5);
  const interval = argNum('interval', 1);
  ensureSeed();

  let lastLog = '';
  let rsiRound = 0;
  console.log(`[assault] workDir=${workDir} rounds=${rounds}`);

  for (let i = 1; i <= rounds; i++) {
    console.log(`\n══ assault round ${i}/${rounds} ══`);
    const before = fs.readFileSync(EXPL, 'utf8');
    const beforeHash = hashFile(EXPL);
    const conj = fs.readFileSync(CONJ, 'utf8');
    let proposedRaw = '';
    let next = before;
    try {
      proposedRaw = await zhipuPropose(before, conj, lastLog);
      const extracted = extractLeanBlock(proposedRaw);
      if (!extracted) throw new Error('no ```lean block in model output');
      next = mergeAppend(before, extracted);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[assault] propose failed:', msg.slice(0, 200));
      appendJournal({ round: i, ok: false, stage: 'propose', error: msg.slice(0, 500) });
      continue;
    }

    fs.writeFileSync(EXPL, next, 'utf8');
    const build = lakeBuild();
    lastLog = build.log;
    writeStamp(build.ok, build.log);
    console.log(`[lake build] exit=${build.exitCode} ok=${build.ok} explHash ${beforeHash}→${hashFile(EXPL)}`);

    if (!build.ok) {
      const failDir = path.join(workDir, '.brain', 'assault-failed');
      fs.mkdirSync(failDir, { recursive: true });
      fs.writeFileSync(path.join(failDir, `r${i}.lean`), next);
      fs.writeFileSync(path.join(failDir, `r${i}.log`), build.log.slice(-4000));
      fs.writeFileSync(EXPL, before, 'utf8');
      writeStamp(false, build.log);
      console.warn('[assault] build failed — reverted Exploration.lean');
    } else if (next !== before) {
      createNodeSkillStore(workDir).writeSkill(LEAN_NODE, {
        category: 'lean',
        title: `Assault round ${i} exploration`,
        tags: ['collatz', 'assault', `r${i}`],
        content: `Round ${i} Exploration update (hash ${hashFile(EXPL)}). Keep lake green; conjecture may stay open.`,
      });
    }

    writeRunContext(workDir, {
      burstId: `assault-r${i}`,
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: build.ok,
      ...(build.ok ? {} : { failedAt: 'lake-build' }),
      nodes: [
        {
          nodeInstId: 'lean-build',
          ref: LEAN_NODE,
          ok: build.ok,
          entries: [
            {
              toolName: 'zhipu_propose',
              args: { round: i },
              result: { ok: true, output: proposedRaw.slice(0, 800) },
            },
            {
              toolName: 'lake_build',
              args: { command: 'lake build' },
              result: { ok: build.ok, output: build.log.slice(0, 1200) },
            },
          ],
        },
      ],
      results: [],
    });

    // Each assault round uses a fresh burstId → per-burst rsiRound starts at 0.
    // Cap (HARNESS_RSI_MAX_ROUNDS) still bounds upgrades *within* one cycle call.
    const rsi = maybeApplyHarnessRsiCycle(workDir, {
      runOk: build.ok,
      rsiRound: 0,
      analyzeInterval: interval,
    });
    if (rsi.applied && 'upgraded' in rsi && rsi.upgraded) rsiRound += 1;
    else if (rsi.applied && 'restartRequested' in rsi && rsi.restartRequested) rsiRound = 0;
    console.log('[harness.rsi]', rsi);
    console.log('[state]', {
      active: createHarnessPointer(workDir).readActive()?.harnessId,
      cadence: readAnalyzeCadence(workDir).attributeCount,
      rsiRound,
    });
    appendJournal({
      round: i,
      ok: build.ok,
      explHash: hashFile(EXPL),
      changed: next !== before,
      rsi,
    });
  }

  console.log(`\n[assault] done — journal ${JOURNAL}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
