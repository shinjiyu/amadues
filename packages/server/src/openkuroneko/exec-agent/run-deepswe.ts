/**
 * 用最小 exec agent 跑一道已缓存的 DeepSWE 题。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   node --import tsx/esm packages/server/src/openkuroneko/exec-agent/run-deepswe.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execCommand, glm53, jevJudge, runExecAgent } from './loop.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const taskId = process.argv[2] ?? 'mashumaro-flattened-dataclass-fields';
const cache = path.join(repoRoot, 'experiments/minimal-react-mdl/.cache-deepswe');
const work = path.join(repoRoot, 'experiments/exec-agent-run', taskId);

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function place(): { cwd: string; task: string } {
  const instruction = fs.readFileSync(path.join(cache, 'deep-swe/tasks', taskId, 'instruction.md'), 'utf8').trim();
  const toml = fs.readFileSync(path.join(cache, 'deep-swe/tasks', taskId, 'task.toml'), 'utf8');
  const commit = toml.match(/^base_commit_hash\s*=\s*"([^"]+)"/m)?.[1];
  if (!commit) throw new Error(`no base commit for ${taskId}`);
  const src = path.join(cache, 'repos', taskId);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(work), { recursive: true });
  const clone = execCommand(`git clone --local ${JSON.stringify(src)} ${JSON.stringify(work)}`, repoRoot);
  if (!clone.ok) throw new Error(clone.output);
  for (const args of [
    ['checkout', '--force', commit],
    ['clean', '-fd'],
    ['config', 'user.email', 'agent@local'],
    ['config', 'user.name', 'agent'],
  ]) {
    const result = execCommand(`git ${args.map(part => JSON.stringify(part)).join(' ')}`, work);
    if (!result.ok) throw new Error(result.output);
  }
  return { cwd: work, task: instruction };
}

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));

const { cwd, task } = place();
console.log(`[exec-agent] ${taskId}`);
console.log(`[exec-agent] cwd ${cwd}`);

const result = await runExecAgent({
  model: glm53(),
  task,
  cwd,
  judge: jevJudge,
  exec: (command, dir) => {
    console.log(`$ ${command.slice(0, 240)}`);
    const ran = execCommand(command, dir);
    console.log(`  -> ${ran.ok ? 'ok' : 'fail'} ${ran.output.slice(0, 180).replace(/\n/g, ' ')}`);
    return ran;
  },
});

console.log(`[exec-agent] stop=${result.stopReason} rounds=${result.rounds} messages=${result.messages.length}`);
const actTools = new Set<string>();
for (const message of result.messages) {
  if (message.role !== 'assistant') continue;
  for (const part of message.content) {
    if (part.type === 'toolCall') actTools.add(part.name);
  }
}
console.log(`[exec-agent] act calls ${[...actTools].join(', ') || '(none)'}`);
const diff = execCommand('git diff --stat HEAD', cwd);
console.log(diff.output || '(no diff)');
