/**
 * Collatz Lean · Harness-RSI minimal loop
 * ADL: doc/structurizr/COLLATZ-LEAN-RSI.md
 *
 * Reuses real harness modules; lake build is the craft gate (not conjecture truth).
 *
 * Usage (from repo root):
 *   export PATH="$HOME/.elan/bin:$HOME/tools/node/bin:$PATH"
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a   # optional LLM later
 *   npx --yes tsx experiments/collatz-lean-rsi/run-loop.ts [--rounds=3] [--interval=1]
 *   npx --yes tsx experiments/collatz-lean-rsi/run-loop.ts --dry-lake   # no Lean toolchain yet
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRunContext } from '../../packages/server/src/openkuroneko/inner-brain/run-context-store.ts';
import { maybeApplyHarnessRsiCycle } from '../../packages/server/src/openkuroneko/inner-brain/harness-rsi-cycle.ts';
import { createHarnessSpecStore } from '../../packages/server/src/openkuroneko/inner-brain/harness-spec-store.ts';
import { createHarnessPointer } from '../../packages/server/src/openkuroneko/inner-brain/harness-pointer.ts';
import { readAnalyzeCadence } from '../../packages/server/src/openkuroneko/inner-brain/harness-analyze.ts';
import { createNodeSkillStore } from '../../packages/server/src/openkuroneko/inner-brain/node-skill-store.ts';

const LEAN_NODE = 'local/lean-build';
const LEAN_TC_BIN = path.join(
  process.env.HOME ?? '',
  '.elan/toolchains/leanprover--lean4---v4.14.0/bin',
);

// Prefer installed Lean toolchain bins over broken elan shims
if (fs.existsSync(path.join(LEAN_TC_BIN, 'lake'))) {
  process.env.PATH = `${LEAN_TC_BIN}${path.delimiter}${process.env.PATH ?? ''}`;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = here;

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argNum(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Structural sanity when Lean toolchain is not installed yet. */
function dryLakeBuild(): { ok: boolean; stdout: string; stderr: string; exitCode: number } {
  const need = ['Collatz/Conjecture.lean', 'Collatz/Exploration.lean', 'Collatz.lean'];
  const missing = need.filter((f) => !fs.existsSync(path.join(workDir, f)));
  if (missing.length) {
    return {
      ok: false,
      stdout: '',
      stderr: `dry-lake missing: ${missing.join(', ')}`,
      exitCode: 1,
    };
  }
  const conj = fs.readFileSync(path.join(workDir, 'Collatz/Conjecture.lean'), 'utf8');
  if (!/theorem conjecture/.test(conj) || !/sorry/.test(conj)) {
    return {
      ok: false,
      stdout: '',
      stderr: 'dry-lake: Conjecture.lean must state theorem conjecture with sorry',
      exitCode: 1,
    };
  }
  return {
    ok: true,
    stdout: 'dry-lake: sources present; conjecture left open (sorry)\n',
    stderr: '',
    exitCode: 0,
  };
}

function lakeBuild(dry: boolean): { ok: boolean; stdout: string; stderr: string; exitCode: number } {
  if (dry) return dryLakeBuild();
  const r = spawnSync('lake', ['build'], {
    cwd: workDir,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) {
    return {
      ok: false,
      stdout: r.stdout ?? '',
      stderr: `${r.stderr ?? ''}\n${r.error.message}\n(hint: install Lean 4.14 or pass --dry-lake)`,
      exitCode: 1,
    };
  }
  return {
    ok: (r.status ?? 1) === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.status ?? 1,
  };
}

function writeBuildStamp(ok: boolean, detail: string): void {
  const stamp = path.join(workDir, '.brain', 'lean-build.ok');
  const log = path.join(workDir, '.brain', 'lean-last-build.json');
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  if (ok) fs.writeFileSync(stamp, `${new Date().toISOString()}\n`, 'utf8');
  else if (fs.existsSync(stamp)) fs.unlinkSync(stamp);
  fs.writeFileSync(
    log,
    JSON.stringify({ ok, detail: detail.slice(0, 4000), at: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

function ensureGateFixtures(): void {
  const p = path.join(workDir, '.brain', 'harness', 'fixtures', 'gate.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) return;
  fs.writeFileSync(
    p,
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
    'utf8',
  );
}

function ensureLeanTacticSkill(): void {
  const store = createNodeSkillStore(workDir);
  if (store.readIndex(LEAN_NODE).length > 0) return;
  store.writeSkill(LEAN_NODE, {
    category: 'lean',
    title: 'Collatz Lean craft',
    tags: ['collatz', 'lean', 'sorry'],
    content: [
      '# Collatz Lean craft',
      '',
      '- Keep `lake build` green; conjecture may remain `sorry`.',
      '- Prefer small lemmas in `Collatz/Exploration.lean` over editing the open theorem.',
      '- Gate = compile, not truth of 3n+1.',
    ].join('\n'),
  });
}

function ensureSeedHarness(): void {
  const store = createHarnessSpecStore(workDir);
  const ptr = createHarnessPointer(workDir, store);
  if (ptr.readActive()) return;
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

function main(): void {
  const rounds = argNum('rounds', 3);
  const interval = argNum('interval', 1);
  const dry = hasFlag('dry-lake');
  ensureGateFixtures();
  ensureLeanTacticSkill();

  console.log(
    `[collatz-loop] workDir=${workDir} rounds=${rounds} analyzeInterval=${interval} dryLake=${dry}`,
  );

  let rsiRound = 0;
  for (let i = 1; i <= rounds; i++) {
    console.log(`\n── round ${i}/${rounds} ──`);
    const build = lakeBuild(dry);
    const detail = `${build.stdout}\n${build.stderr}`.trim();
    writeBuildStamp(build.ok, detail);
    console.log(`[lake build] exit=${build.exitCode} ok=${build.ok}`);

    writeRunContext(workDir, {
      burstId: `collatz-r${i}`,
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
              toolName: 'lake_build',
              args: { command: dry ? 'dry-lake' : 'lake build' },
              result: { ok: build.ok, output: detail.slice(0, 1500) },
            },
          ],
        },
      ],
      results: [],
    });

    if (i === 1 && build.ok) ensureSeedHarness();

    const rsi = maybeApplyHarnessRsiCycle(workDir, {
      runOk: build.ok,
      rsiRound,
      analyzeInterval: interval,
    });
    console.log('[harness.rsi]', rsi);
    if (rsi.applied && 'upgraded' in rsi && rsi.upgraded) rsiRound += 1;

    const cadence = readAnalyzeCadence(workDir);
    const active = createHarnessPointer(workDir).readActive();
    console.log('[state]', {
      attributeCount: cadence.attributeCount,
      active: active?.harnessId ?? null,
      rsiRound,
    });
  }

  console.log('\n[collatz-loop] done');
}

main();
