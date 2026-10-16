/**
 * Blender 青蛙 → H5 冒烟题（桥 HTTP via exec；无 create_tool）。
 *
 * 前置：Blender 开着且 blender-meta-mcp 在 :11588 监听。
 *
 *   npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-blender-frog.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveWriter } from './live-progress.ts';
import { applyAgentSeed, execCommand, glm53, jevJudge, runExecAgent } from './loop.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const taskDir = path.join(repoRoot, 'experiments/exec-agent-blender-frog');
const work = path.join(taskDir, 'work');
const liveDir = path.join(taskDir, 'live');
const seedDir = path.join(taskDir, 'seed');
const bridge = process.env.BLENDER_MCP_BRIDGE ?? 'http://127.0.0.1:11588';

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
    'git init && git config user.email agent@local && git config user.name agent && echo "# blender-frog" > README.md && git add README.md && git commit -q -m seed',
    work,
  );
  if (!git.ok) throw new Error(git.output);
  applyAgentSeed(seedDir, work);
  return { cwd: work, task: instruction };
}

function bridgeOk(): boolean {
  const ran = execCommand(`curl -sS --max-time 5 "${bridge}/health"`, work);
  if (!ran.ok) return false;
  try {
    const body = JSON.parse(ran.output.trim().split('\n').pop() || ran.output);
    return body?.ok === true;
  } catch {
    return ran.output.includes('"ok"') && ran.output.includes('true');
  }
}

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));
if (!process.env.ZAI_CODING_CN_API_KEY && process.env.ZHIPU_API_KEY) {
  process.env.ZAI_CODING_CN_API_KEY = process.env.ZHIPU_API_KEY;
}

if (!bridgeOk()) {
  console.error(`[exec-agent] Blender bridge unreachable at ${bridge}`);
  console.error('[exec-agent] Open Blender, enable blender-meta-mcp addon, then retry.');
  process.exit(3);
}

const { cwd, task } = place();
const live = createLiveWriter(liveDir, {
  task: 'blender-frog-h5',
  cwd,
  pid: process.pid,
});
console.log('[exec-agent] blender-frog-h5');
console.log(`[exec-agent] cwd ${cwd}`);
console.log(`[exec-agent] bridge ${bridge}`);
console.log(`[exec-agent] live ${live.path}`);
console.log('[exec-agent] progress: point progress-server at this live/ or read status.json');
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
const hasGlbRef = /\.glb|\.gltf/i.test(indexHtml);
const glbFiles = fs.existsSync(cwd)
  ? fs.readdirSync(cwd).filter(name => /\.glb$/i.test(name))
  : [];
const hasGlbFile = glbFiles.length > 0 || fs.existsSync(path.join(cwd, 'frog.glb'));
const glbBytes = (() => {
  const p = path.join(cwd, 'frog.glb');
  if (fs.existsSync(p)) return fs.statSync(p).size;
  for (const name of glbFiles) {
    const p2 = path.join(cwd, name);
    if (fs.existsSync(p2)) return fs.statSync(p2).size;
  }
  return 0;
})();
/** Unbaked / empty shells are typically << 1MB; baked skin maps push multi-MB. */
const hasSubstantialGlb = glbBytes >= 800_000;
const proofPath = path.join(cwd, 'reports/vision-proof.md');
const designPath = path.join(cwd, 'reports/design.md');
const proofText = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, 'utf8') : '';
const proofCue = /frog|green|light|shadow|sky|fog|tint|specul|rough|subsurface|sss|wet|cornea|iris|瞳|高光|材质|皮肤|湿|色/i.test(proofText);
const shotExists = [
  'reports/scene.png',
  'reports/scene.jpg',
  'reports/screenshot.png',
].some(rel => fs.existsSync(path.join(cwd, rel)));
const visionOk = proofCue && shotExists;

live.tools(result.registeredTools, result.rules, result.skills, Object.fromEntries(actTools));
live.done(result.stopReason);

console.log(`[exec-agent] stop=${result.stopReason} rounds=${result.rounds} messages=${result.messages.length}`);
console.log(`[exec-agent] act calls ${[...actTools.entries()].map(([name, n]) => `${name}×${n}`).join(', ') || '(none)'}`);
console.log(`[exec-agent] rules ${result.rules.join(', ') || '(none)'} skills ${result.skills.join(', ') || '(none)'}`);
console.log(`[exec-agent] glb file=${hasGlbFile} bytes=${glbBytes} substantial=${hasSubstantialGlb} (${glbFiles.join(',') || 'frog.glb?'}) index=${Boolean(indexHtml)} light=${hasLight} color=${hasColorCue} glbRef=${hasGlbRef}`);
console.log(`[exec-agent] proof ${fs.existsSync(proofPath) ? 'present' : 'missing'} design ${fs.existsSync(designPath) ? 'present' : 'missing'} shot=${shotExists} proof-cue=${proofCue}`);
console.log(
  `[exec-agent] hard-gate glb=${hasGlbFile && hasGlbRef && hasSubstantialGlb} light=${hasLight && hasColorCue} vision=${visionOk}`,
);

const diff = execCommand('git status --short && git diff --stat HEAD', cwd);
console.log(diff.output || '(clean)');

if (!(hasGlbFile && hasGlbRef && hasSubstantialGlb && hasLight && hasColorCue && visionOk)) {
  process.exitCode = 2;
}
