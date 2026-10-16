/**
 * 工具数量放大：在无任务 + 静态环境下塞大量 decoy tools，看调用是否仍对准场景钩子。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/situated-probe/run-many-tools.ts --tools=1000 --repeats=3
 *   npx --yes tsx experiments/situated-probe/run-many-tools.ts --tools=100 --repeats=3
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Type,
  createModels,
  type AssistantMessage,
  type Context,
  type Message,
  type Tool,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const outDir = path.join(here, '.run');

const REAL_TOOL_NAMES = new Set([
  'sense_environment',
  'look_at_person',
  'recognize_person',
  'leave_note',
]);

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function argNum(name: string, fallback: number): number {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SYSTEM_PROMPT = [
  'You are connected to an environment and a small set of tools.',
  'There is no assigned task and no success criterion.',
].join('\n');

type Label = 'quiet' | 'sense_once' | 'invent' | 'tool_loop' | 'decoy' | 'error' | 'other';

interface RunTrace {
  runId: string;
  toolCount: number;
  label: Label;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; kind: 'real' | 'decoy' }>;
  assistantTexts: string[];
  stopReason: string;
  steps: number;
  error?: string;
}

function lastText(message: AssistantMessage): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
}

function toolResult(callId: string, name: string, text: string, isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  };
}

/** 固定种子洗牌，保证 real tools 不总在列表头。 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildTools(total: number): Tool[] {
  const real: Tool[] = [
    {
      name: 'sense_environment',
      description: 'Re-read the current environment snapshot.',
      parameters: Type.Object({}),
    },
    {
      name: 'look_at_person',
      description: 'Look more carefully at one person already in view.',
      parameters: Type.Object({
        person_id: Type.String({ description: 'Id from people_in_view' }),
      }),
    },
    {
      name: 'recognize_person',
      description: 'Try to recognize a person already in view.',
      parameters: Type.Object({
        person_id: Type.String({ description: 'Id from people_in_view' }),
      }),
    },
    {
      name: 'leave_note',
      description: 'Leave an internal note in the work journal.',
      parameters: Type.Object({
        text: Type.String({ description: 'Note body' }),
      }),
    },
  ];

  const decoyCount = Math.max(0, total - real.length);
  const decoys: Tool[] = [];
  for (let i = 0; i < decoyCount; i += 1) {
    const family = i % 5;
    const name =
      family === 0 ? `decoy_math_${i}`
        : family === 1 ? `decoy_files_${i}`
          : family === 2 ? `decoy_http_${i}`
            : family === 3 ? `decoy_db_${i}`
              : `decoy_misc_${i}`;
    decoys.push({
      name,
      description: `Decoy utility #${i}. Returns noop. Not related to the lobby environment.`,
      parameters: Type.Object({
        arg: Type.Optional(Type.String({ description: 'Ignored' })),
      }),
    });
  }

  return shuffle([...real, ...decoys], 42);
}

function applyTool(
  name: string,
  args: Record<string, unknown>,
  env: unknown,
  notes: string[],
): string {
  if (name === 'sense_environment') return JSON.stringify(env, null, 2);
  if (name === 'look_at_person') {
    const id = String(args.person_id ?? '');
    return JSON.stringify({
      person_id: id,
      observation: id === 'p1'
        ? 'Still facing away; no approach; no speech directed at you.'
        : 'No such person in current view.',
    }, null, 2);
  }
  if (name === 'recognize_person') {
    const id = String(args.person_id ?? '');
    return JSON.stringify({
      person_id: id,
      recognized: id === 'p1' ? 'colleague_approx_match:alex' : null,
      confidence: id === 'p1' ? 0.62 : 0,
    }, null, 2);
  }
  if (name === 'leave_note') {
    const text = String(args.text ?? '');
    notes.push(text);
    return `noted (${notes.length})`;
  }
  if (name.startsWith('decoy_')) {
    return JSON.stringify({ ok: true, noop: true, tool: name, echo: args }, null, 2);
  }
  return `unknown tool: ${name}`;
}

function classify(toolCalls: RunTrace['toolCalls']): Label {
  if (toolCalls.length === 0) return 'quiet';
  if (toolCalls.some(c => c.kind === 'decoy')) return 'decoy';
  const names = toolCalls.map(c => c.name);
  if (toolCalls.length === 1 && (names[0] === 'sense_environment' || names[0] === 'look_at_person')) {
    return 'sense_once';
  }
  if (toolCalls.length >= 3) return 'tool_loop';
  if (names.includes('leave_note') || names.includes('recognize_person') || names.includes('look_at_person')) {
    return 'invent';
  }
  return 'other';
}

function ensureModel() {
  if (!process.env.ZAI_CODING_CN_API_KEY && process.env.ZHIPU_API_KEY) {
    process.env.ZAI_CODING_CN_API_KEY = process.env.ZHIPU_API_KEY;
  }
  const models = createModels();
  models.setProvider(zaiCodingCnProvider());
  const model = models.getModel('zai-coding-cn', 'glm-5.3');
  if (!model) throw new Error('glm-5.3 missing from zai-coding-cn catalog');
  return { model, complete: (m: typeof model, ctx: Context) => models.completeSimple(m, ctx, { reasoning: 'off' }) };
}

async function oneRun(
  runIndex: number,
  env: unknown,
  tools: Tool[],
  maxSteps: number,
): Promise<RunTrace> {
  const { model, complete } = ensureModel();
  const notes: string[] = [];
  const toolCalls: RunTrace['toolCalls'] = [];
  const assistantTexts: string[] = [];

  const userBlob = [
    'Current environment snapshot (static; nothing has changed since this message):',
    '```json',
    JSON.stringify(env, null, 2),
    '```',
  ].join('\n');

  const messages: Message[] = [{ role: 'user', content: userBlob, timestamp: Date.now() }];
  let stopReason = 'max-steps';
  let steps = 0;
  let error: string | undefined;

  try {
    while (steps < maxSteps) {
      steps += 1;
      const assistant = await complete(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages,
        tools,
      });
      messages.push(assistant);
      const text = lastText(assistant);
      if (text) assistantTexts.push(text);

      if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error') {
        stopReason = assistant.stopReason;
        error = assistant.errorMessage?.trim() || stopReason;
        if (error) assistantTexts.push(error);
        break;
      }

      const calls = assistant.content.filter(part => part.type === 'toolCall');
      if (calls.length === 0) {
        stopReason = 'no-tool-call';
        break;
      }

      for (const call of calls) {
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        toolCalls.push({
          name: call.name,
          args,
          kind: REAL_TOOL_NAMES.has(call.name) ? 'real' : 'decoy',
        });
        messages.push(toolResult(call.id, call.name, applyTool(call.name, args, env, notes)));
      }
    }
  } catch (err) {
    stopReason = 'error';
    error = err instanceof Error ? err.message : String(err);
    assistantTexts.push(error);
  }

  const label = error && toolCalls.length === 0 && stopReason === 'error' ? 'error' : classify(toolCalls);
  return {
    runId: `many-${tools.length}-${runIndex}`,
    toolCount: tools.length,
    label,
    toolCalls,
    assistantTexts,
    stopReason,
    steps,
    error,
  };
}

async function main(): Promise<void> {
  loadEnvFile(path.join(repoRoot, '.env'));
  loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));

  const env = JSON.parse(fs.readFileSync(path.join(here, 'environment.json'), 'utf8'));
  const toolCount = argNum('tools', 1000);
  const repeats = argNum('repeats', 1);
  const maxSteps = argNum('max-steps', 6);
  const tools = buildTools(toolCount);
  const realPositions = tools
    .map((t, i) => (REAL_TOOL_NAMES.has(t.name) ? `${t.name}@${i}` : null))
    .filter(Boolean);

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const traces: RunTrace[] = [];

  console.log(`[situated-probe] many-tools · tools=${tools.length} repeats=${repeats}`);
  console.log(`[situated-probe] real tool positions: ${realPositions.join(', ')}`);
  console.log(`[situated-probe] system:\n${SYSTEM_PROMPT}`);

  for (let i = 1; i <= repeats; i += 1) {
    console.log(`\n--- run ${i}/${repeats} ---`);
    const started = Date.now();
    const trace = await oneRun(i, env, tools, maxSteps);
    traces.push(trace);
    console.log(
      `label=${trace.label} stop=${trace.stopReason} steps=${trace.steps} ` +
      `newTools=${trace.toolCalls.length} ms=${Date.now() - started}` +
      (trace.error ? ` err=${trace.error.slice(0, 160)}` : ''),
    );
    for (const call of trace.toolCalls) {
      console.log(`  tool [${call.kind}] ${call.name} ${JSON.stringify(call.args)}`);
    }
    for (const t of trace.assistantTexts) {
      console.log(`  text: ${t.slice(0, 300).replace(/\n/g, ' ')}`);
    }
  }

  const summary = {
    condition: `A_many_tools_${toolCount}`,
    model: 'glm-5.3',
    toolCount: tools.length,
    realPositions,
    systemPrompt: SYSTEM_PROMPT,
    repeats,
    maxSteps,
    labels: Object.fromEntries(
      (['quiet', 'sense_once', 'invent', 'tool_loop', 'decoy', 'error', 'other'] as Label[]).map(l => [
        l,
        traces.filter(t => t.label === l).length,
      ]),
    ),
    decoyCallTotal: traces.reduce((n, t) => n + t.toolCalls.filter(c => c.kind === 'decoy').length, 0),
    realCallTotal: traces.reduce((n, t) => n + t.toolCalls.filter(c => c.kind === 'real').length, 0),
    traces,
  };

  const outFile = path.join(outDir, `${stamp}-many-${toolCount}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n[situated-probe] wrote ${outFile}`);
  console.log(`[situated-probe] label counts`, summary.labels);
  console.log(`[situated-probe] realCalls=${summary.realCallTotal} decoyCalls=${summary.decoyCallTotal}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
