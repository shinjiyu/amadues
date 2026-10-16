/**
 * game-eval 2048 · Amadeus exec-only miniagent arm.
 *
 * Does NOT wipe the Candidate. Expects GAME_EVAL_WORKDIR (registered project).
 * Seeds .agent/ from experiments/exec-agent-gamegen-2048/seed/ (exec-only tools.json).
 *
 *   GAME_EVAL_WORKDIR=/path/to/candidate \
 *     npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-gamegen-2048.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveWriter } from './live-progress.ts';
import { applyAgentSeed, execCommand, glm53, jevJudge, runExecAgent } from './loop.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const taskDir = path.join(repoRoot, 'experiments/exec-agent-gamegen-2048');
const liveDir = process.env.EXEC_AGENT_LIVE_DIR
  ? path.resolve(process.env.EXEC_AGENT_LIVE_DIR)
  : path.join(taskDir, 'live');
const seedDir = path.join(taskDir, 'seed');
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_AGENT_TIMEOUT_MS ?? 600_000);

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function longExec(command: string, cwd: string): { ok: boolean; output: string } {
  return execCommand(command, cwd, EXEC_TIMEOUT_MS);
}

function place(): { cwd: string; task: string } {
  const workdir = process.env.GAME_EVAL_WORKDIR?.trim();
  if (!workdir) {
    throw new Error('GAME_EVAL_WORKDIR is required (absolute path from game-eval project create)');
  }
  const cwd = path.resolve(workdir);
  if (!fs.existsSync(path.join(cwd, 'instruction.md'))) {
    throw new Error(`instruction.md missing in ${cwd}`);
  }
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`package.json missing in ${cwd} — not a Cocos Candidate?`);
  }
  const wrapper = fs.readFileSync(path.join(taskDir, 'instruction.md'), 'utf8').trim();
  const projectInstruction = fs.readFileSync(path.join(cwd, 'instruction.md'), 'utf8').trim();
  const task = `${wrapper}\n\n---\n\n# Project instruction.md (authoritative)\n\n${projectInstruction}`;
  applyAgentSeed(seedDir, cwd);
  return { cwd, task };
}

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));
if (!process.env.ZAI_CODING_CN_API_KEY && process.env.ZHIPU_API_KEY) {
  process.env.ZAI_CODING_CN_API_KEY = process.env.ZHIPU_API_KEY;
}

const { cwd, task } = place();
const live = createLiveWriter(liveDir, {
  task: 'gamegen-2048',
  cwd,
  pid: process.pid,
});
console.log('[exec-agent] gamegen-2048');
console.log(`[exec-agent] cwd ${cwd}`);
console.log(`[exec-agent] live ${live.path}`);
console.log(`[exec-agent] exec timeout ${EXEC_TIMEOUT_MS}ms`);
console.log('[exec-agent] progress: EXEC_AGENT_EXPERIMENT=exec-agent-gamegen-2048 progress-server');
live.setPhase('act', true);

const result = await runExecAgent({
  model: glm53(),
  task,
  cwd,
  judge: jevJudge,
  onEvent: event => {
    if (event.type === 'llm-start') {
      live.setPhase(event.phase, true);
      return;
    }
    if (event.type === 'llm-end') {
      live.note('llm-end', { phase: event.phase, waitingSince: null });
      return;
    }
    if (event.type === 'reflect-tool') {
      live.note('reflect-tool', {});
      live.refreshArtifacts();
      return;
    }
    if (event.type === 'act-tool') {
      live.actTool(event.name, event.uses);
      return;
    }
    if (event.type === 'memory') {
      live.tools(event.registeredTools, event.rules, event.skills);
      live.refreshArtifacts();
    }
  },
  exec: (command, dir) => {
    console.log(`$ ${command.slice(0, 240)}`);
    const ran = longExec(command, dir);
    console.log(`  -> ${ran.ok ? 'ok' : 'fail'} ${ran.output.slice(0, 180).replace(/\n/g, ' ')}`);
    live.exec(command, ran.ok, ran.output);
    return ran;
  },
});

const actTools = new Map<string, number>();
for (const message of result.messages) {
  if (message.role !== 'assistant') continue;
  for (const part of message.content) {
    if (part.type !== 'toolCall') continue;
    actTools.set(part.name, (actTools.get(part.name) ?? 0) + 1);
  }
}

live.tools(result.registeredTools, result.rules, result.skills, Object.fromEntries(actTools));
live.done(result.stopReason);

const hasInstruction = fs.existsSync(path.join(cwd, 'instruction.md'));
const hasAdapterDocs =
  fs.existsSync(path.join(cwd, 'data.md')) && fs.existsSync(path.join(cwd, 'state_injection_api.md'));
const contractCheck = path.join(cwd, 'check-evaluation-contract.mjs');
let contractOk = false;
if (fs.existsSync(contractCheck)) {
  const check = longExec(`node ${JSON.stringify(contractCheck)}`, cwd);
  contractOk = check.ok;
  console.log(`[exec-agent] contract-check ${contractOk ? 'ok' : 'fail'}`);
  if (!contractOk) console.log(check.output.slice(0, 800));
}

console.log(`[exec-agent] stop=${result.stopReason} rounds=${result.rounds} messages=${result.messages.length}`);
console.log(`[exec-agent] act calls ${[...actTools.entries()].map(([name, n]) => `${name}×${n}`).join(', ') || '(none)'}`);
console.log(`[exec-agent] registered ${result.registeredTools.join(', ') || '(none)'} (seed only)`);
console.log(`[exec-agent] rules ${result.rules.join(', ') || '(none)'} skills ${result.skills.join(', ') || '(none)'}`);
console.log(`[exec-agent] soft-gate instruction=${hasInstruction} adapter-docs=${hasAdapterDocs} contract=${contractOk}`);

const diff = longExec('git status --short && git diff --stat HEAD', cwd);
console.log(diff.output || '(clean)');

if (!(hasInstruction && hasAdapterDocs && contractOk)) {
  process.exitCode = 2;
}
