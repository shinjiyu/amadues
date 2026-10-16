/**
 * 用最小 exec agent 跑 Kura H5 3D 地图冒烟题（打光照上色 + 视觉验收）。
 * 跑前注入 seed/（事后分析 rules/skills）；运行中无 create_tool。
 *
 *   npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-kura-h5.ts
 * 进度页：
 *   npx --yes tsx packages/server/src/openkuroneko/exec-agent/progress-server.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveWriter } from './live-progress.ts';
import { applyAgentSeed, execCommand, glm53, jevJudge, runExecAgent } from './loop.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const taskDir = path.join(repoRoot, 'experiments/exec-agent-kura-h5');
const work = path.join(taskDir, 'work');
const liveDir = path.join(taskDir, 'live');
const seedDir = path.join(taskDir, 'seed');

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function place(): { cwd: string; task: string } {
  const instruction = fs.readFileSync(path.join(taskDir, 'instruction.md'), 'utf8').trim();
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const git = execCommand(
    'git init && git config user.email agent@local && git config user.name agent && echo "# kura-h5" > README.md && git add README.md && git commit -q -m seed',
    work,
  );
  if (!git.ok) throw new Error(git.output);
  applyAgentSeed(seedDir, work);
  return { cwd: work, task: instruction };
}

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));
if (!process.env.ZAI_CODING_CN_API_KEY && process.env.ZHIPU_API_KEY) {
  process.env.ZAI_CODING_CN_API_KEY = process.env.ZHIPU_API_KEY;
}

const { cwd, task } = place();
const live = createLiveWriter(liveDir, {
  task: 'kura-h5-map',
  cwd,
  pid: process.pid,
});
console.log('[exec-agent] kura-h5-map');
console.log(`[exec-agent] cwd ${cwd}`);
console.log(`[exec-agent] live ${live.path}`);
console.log('[exec-agent] progress http://127.0.0.1:8932');
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
    const ran = execCommand(command, dir);
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

const indexPath = path.join(cwd, 'index.html');
const indexHtml = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
const hasLight = /DirectionalLight|HemisphereLight|AmbientLight|PointLight|SpotLight|RectAreaLight/i.test(indexHtml);
const hasColorCue = /fog|Color\(|emissive|shadow|toneMapping|background/i.test(indexHtml);
const hasGlb = /\.glb|\.gltf/i.test(indexHtml);
const proofPath = path.join(cwd, 'reports/vision-proof.md');
const designPath = path.join(cwd, 'reports/design.md');
const proofText = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, 'utf8') : '';
const proofCue = /light|shadow|sky|fog|tint|colour|color|warm|cool|sun|glow|黄|红|蓝|绿|光|影|雾|色/i.test(proofText);
const shotExists = [
  'reports/scene.png',
  'reports/scene.jpg',
  'reports/screenshot.png',
  'reports/screenshot.jpg',
].some(rel => fs.existsSync(path.join(cwd, rel)));
const registered = result.registeredTools;
const visionUsed = [...actTools.entries()].some(([name, n]) => name !== 'exec' && n > 0);
const visionOk = (proofCue && shotExists) || visionUsed;

live.tools(registered, result.rules, result.skills, Object.fromEntries(actTools));
live.done(result.stopReason);

console.log(`[exec-agent] stop=${result.stopReason} rounds=${result.rounds} messages=${result.messages.length}`);
console.log(`[exec-agent] act calls ${[...actTools.entries()].map(([name, n]) => `${name}×${n}`).join(', ') || '(none)'}`);
console.log(`[exec-agent] registered ${registered.join(', ') || '(none)'} (seed only; no create_tool)`);
console.log(`[exec-agent] rules ${result.rules.join(', ') || '(none)'} skills ${result.skills.join(', ') || '(none)'}`);
console.log(`[exec-agent] index.html ${indexHtml ? 'present' : 'missing'} light=${hasLight} color=${hasColorCue} glb=${hasGlb}`);
console.log(`[exec-agent] proof ${fs.existsSync(proofPath) ? 'present' : 'missing'} design ${fs.existsSync(designPath) ? 'present' : 'missing'} shot=${shotExists} proof-cue=${proofCue}`);
console.log(
  `[exec-agent] hard-gate light=${hasLight && hasColorCue} assets=${hasGlb} vision=${visionOk}`,
);

const diff = execCommand('git status --short && git diff --stat HEAD', cwd);
console.log(diff.output || '(clean)');

if (!(hasLight && hasColorCue && hasGlb && visionOk)) {
  process.exitCode = 2;
}
