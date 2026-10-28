/**
 * Enji / Three.js × Tetris / Rubik token bench · DeepSeek V4.1 Flash.
 *
 *   CASE=tetris-enji WORKDIR=/path \
 *     node --import tsx packages/server/src/openkuroneko/exec-agent/run-enji-three-token.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveWriter } from './live-progress.ts';
import {
  applyAgentSeed,
  deepseekFlash,
  execCommand,
  jevJudge,
  runExecAgent,
  sumMessageUsage,
} from './loop.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const expRoot = path.join(repoRoot, 'experiments/exec-agent-enji-three-token');
const seedDir = path.join(expRoot, 'seed');
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_AGENT_TIMEOUT_MS ?? 600_000);
const MAX_ROUNDS = Number(process.env.EXEC_AGENT_MAX_ROUNDS ?? 25);
const MAX_STEPS = Number(process.env.EXEC_AGENT_MAX_STEPS ?? 120);

const CASES = new Set(['tetris-enji', 'tetris-three', 'rubik-enji', 'rubik-three']);

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]!]) continue;
    process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
  }
}

function longExec(command: string, cwd: string): { ok: boolean; output: string } {
  return execCommand(command, cwd, EXEC_TIMEOUT_MS);
}

function place(): { caseId: string; cwd: string; task: string; outDir: string } {
  const caseId = (process.env.CASE ?? '').trim();
  if (!CASES.has(caseId)) {
    throw new Error(`CASE must be one of ${[...CASES].join(', ')}`);
  }
  const workdir = process.env.WORKDIR?.trim();
  if (!workdir) throw new Error('WORKDIR is required (absolute path)');
  const cwd = path.resolve(workdir);
  if (!fs.existsSync(cwd)) throw new Error(`WORKDIR missing: ${cwd}`);

  const caseInstruction = fs.readFileSync(path.join(expRoot, 'cases', `${caseId}.md`), 'utf8').trim();
  const agentsPath = path.join(cwd, 'AGENTS.md');
  const agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8').trim() : '';
  const task = [
    caseInstruction,
    agents ? `\n---\n\n# Project AGENTS.md (authoritative)\n\n${agents}` : '',
    '\n---\n\nYou only have the `exec` tool. Stay inside this working directory.',
  ].join('\n');

  applyAgentSeed(seedDir, cwd);

  const outDir = process.env.EXEC_AGENT_OUT_DIR
    ? path.resolve(process.env.EXEC_AGENT_OUT_DIR)
    : path.join(expRoot, 'results', caseId);
  fs.mkdirSync(outDir, { recursive: true });
  return { caseId, cwd, task, outDir };
}

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));
if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('DEEPSEEK_API_KEY is required (DeepSeek V4.1 Flash / deepseek-flash)');
}
if (!process.env.TYPESAFE_API_KEY && !process.env.JEV_KEY) {
  throw new Error('TYPESAFE_API_KEY or JEV_KEY is required for jevJudge');
}

const { caseId, cwd, task, outDir } = place();
const liveDir = process.env.EXEC_AGENT_LIVE_DIR
  ? path.resolve(process.env.EXEC_AGENT_LIVE_DIR)
  : path.join(outDir, 'live');
fs.mkdirSync(liveDir, { recursive: true });

const live = createLiveWriter(liveDir, {
  task: caseId,
  cwd,
  pid: process.pid,
});

const startedAt = new Date().toISOString();
console.log(`[exec-agent] case=${caseId}`);
console.log(`[exec-agent] model=deepseek-flash (DeepSeek V4.1 Flash)`);
console.log(`[exec-agent] cwd ${cwd}`);
console.log(`[exec-agent] out ${outDir}`);
console.log(`[exec-agent] maxRounds=${MAX_ROUNDS} maxSteps=${MAX_STEPS} execTimeout=${EXEC_TIMEOUT_MS}ms`);
live.setPhase('act', true);

const result = await runExecAgent({
  model: deepseekFlash(),
  task,
  cwd,
  judge: jevJudge,
  maxRounds: MAX_ROUNDS,
  maxSteps: MAX_STEPS,
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

const usage = sumMessageUsage(result.messages);
const finishedAt = new Date().toISOString();
const summary = {
  caseId,
  model: 'deepseek-flash',
  modelLabel: 'DeepSeek V4.1 Flash',
  cwd,
  startedAt,
  finishedAt,
  stopReason: result.stopReason,
  rounds: result.rounds,
  usage: {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    promptIncludingCache: usage.input + usage.cacheRead,
    llmCalls: usage.calls,
  },
};

fs.writeFileSync(path.join(outDir, 'usage.json'), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(
  path.join(outDir, 'result-meta.json'),
  `${JSON.stringify({ stopReason: result.stopReason, rounds: result.rounds, rules: result.rules, skills: result.skills }, null, 2)}\n`,
);

console.log('[exec-agent] usage', JSON.stringify(summary.usage));
console.log(`[exec-agent] wrote ${path.join(outDir, 'usage.json')}`);
process.exitCode = result.stopReason === 'complete' || result.stopReason === 'no-tool-call' ? 0 : 1;
