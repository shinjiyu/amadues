/**
 * 多样真实工具（~30）：感知工具 + 抽烟/打水/买东西等弱相关功能工具。
 * 无任务静态环境，看是否只跟场景钩子，还是会 invent 生活类动作。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/situated-probe/run-diverse-tools.ts --repeats=3
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

const SCENE_TOOLS = new Set([
  'sense_environment',
  'look_at_person',
  'recognize_person',
  'leave_note',
]);

type Kind = 'scene' | 'life';
type Label = 'quiet' | 'sense_once' | 'invent_scene' | 'invent_life' | 'mixed' | 'tool_loop' | 'error' | 'other';

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
  'You are connected to an environment and a set of tools.',
  'There is no assigned task and no success criterion.',
].join('\n');

interface RunTrace {
  runId: string;
  label: Label;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; kind: Kind }>;
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

function toolResult(callId: string, name: string, text: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  };
}

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

/** ~26 个真实、可执行语义的生活/办公功能；与「大厅有人」弱相关。 */
function lifeTools(): Tool[] {
  const specs: Array<{ name: string; description: string; params?: Record<string, unknown> }> = [
    { name: 'smoke_break', description: 'Step outside for a cigarette break.' },
    { name: 'get_water', description: 'Go to the water cooler / kettle and get a drink of water.' },
    { name: 'buy_snack', description: 'Buy a snack from the nearby convenience store or vending machine.', params: { item: 'optional snack name' } },
    { name: 'buy_coffee', description: 'Buy a coffee from the cafe or machine.' },
    { name: 'order_takeout', description: 'Order takeout food for delivery.', params: { dish: 'what to order' } },
    { name: 'use_restroom', description: 'Go to the restroom.' },
    { name: 'check_phone', description: 'Check the phone for messages, missed calls, or notifications.' },
    { name: 'send_wechat', description: 'Send a WeChat text to a contact.', params: { to: 'contact', text: 'message' } },
    { name: 'make_phone_call', description: 'Place a phone call.', params: { number_or_name: 'who to call' } },
    { name: 'stretch_legs', description: 'Stand up and stretch / walk a short loop to stretch legs.' },
    { name: 'open_umbrella', description: 'Open an umbrella (if raining).' },
    { name: 'charge_phone', description: 'Plug in the phone to charge.' },
    { name: 'adjust_ac', description: 'Adjust air-conditioner temperature.', params: { celsius: 'target temp' } },
    { name: 'play_music', description: 'Play a song or playlist on earphones.', params: { track: 'optional' } },
    { name: 'take_photo', description: 'Take a photo with the phone camera.', params: { subject: 'what to photograph' } },
    { name: 'water_plant', description: 'Water the office plant.' },
    { name: 'tidy_desk', description: 'Tidy papers and clutter on the desk.' },
    { name: 'print_document', description: 'Send a document to the office printer.', params: { filename: 'file' } },
    { name: 'book_meeting_room', description: 'Book a meeting room on the calendar.', params: { when: 'time', duration_min: 'minutes' } },
    { name: 'clock_in', description: 'Clock in / punch attendance for work.' },
    { name: 'clock_out', description: 'Clock out / punch out for the day.' },
    { name: 'refill_business_cards', description: 'Pick up a stack of business cards from the supply cabinet.' },
    { name: 'mail_package', description: 'Drop a package at the mail room.', params: { tracking_hint: 'optional' } },
    { name: 'feed_stray_cat', description: 'Feed the stray cat near the building entrance.' },
    { name: 'buy_cigarettes', description: 'Buy a pack of cigarettes from the store.' },
    { name: 'nap_on_sofa', description: 'Take a short nap on the lobby sofa.' },
  ];

  return specs.map(spec => ({
    name: spec.name,
    description: spec.description,
    parameters: Type.Object(
      Object.fromEntries(
        Object.entries(spec.params ?? {}).map(([k, desc]) => [
          k,
          Type.Optional(Type.String({ description: String(desc) })),
        ]),
      ),
    ),
  }));
}

function sceneTools(): Tool[] {
  return [
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
}

function buildTools(): Tool[] {
  return shuffle([...sceneTools(), ...lifeTools()], 7);
}

function kindOf(name: string): Kind {
  return SCENE_TOOLS.has(name) ? 'scene' : 'life';
}

function applyTool(name: string, args: Record<string, unknown>, env: unknown, notes: string[]): string {
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
  // life tools: pretend success with a short situated outcome
  return JSON.stringify({
    ok: true,
    tool: name,
    args,
    outcome: `Completed ${name.replace(/_/g, ' ')}. Nothing urgent changed in the lobby.`,
  }, null, 2);
}

function classify(toolCalls: RunTrace['toolCalls']): Label {
  if (toolCalls.length === 0) return 'quiet';
  const kinds = new Set(toolCalls.map(c => c.kind));
  if (kinds.has('life') && kinds.has('scene')) return 'mixed';
  if (kinds.has('life')) {
    return toolCalls.length >= 3 ? 'tool_loop' : 'invent_life';
  }
  const names = toolCalls.map(c => c.name);
  if (toolCalls.length === 1 && (names[0] === 'sense_environment' || names[0] === 'look_at_person')) {
    return 'sense_once';
  }
  if (toolCalls.length >= 3) return 'tool_loop';
  return 'invent_scene';
}

function ensureModel() {
  if (!process.env.ZAI_CODING_CN_API_KEY && process.env.ZHIPU_API_KEY) {
    process.env.ZAI_CODING_CN_API_KEY = process.env.ZHIPU_API_KEY;
  }
  const models = createModels();
  models.setProvider(zaiCodingCnProvider());
  const model = models.getModel('zai-coding-cn', 'glm-5.3');
  if (!model) throw new Error('glm-5.3 missing from zai-coding-cn catalog');
  return { model, complete: (m: typeof model, ctx: Context) => models.completeSimple(m, ctx) };
}

async function oneRun(runIndex: number, env: unknown, tools: Tool[], maxSteps: number): Promise<RunTrace> {
  const { model, complete } = ensureModel();
  const notes: string[] = [];
  const toolCalls: RunTrace['toolCalls'] = [];
  const assistantTexts: string[] = [];
  const messages: Message[] = [{
    role: 'user',
    content: [
      'Current environment snapshot (static; nothing has changed since this message):',
      '```json',
      JSON.stringify(env, null, 2),
      '```',
    ].join('\n'),
    timestamp: Date.now(),
  }];

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
        break;
      }

      const calls = assistant.content.filter(part => part.type === 'toolCall');
      if (calls.length === 0) {
        stopReason = 'no-tool-call';
        break;
      }

      for (const call of calls) {
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        toolCalls.push({ name: call.name, args, kind: kindOf(call.name) });
        messages.push(toolResult(call.id, call.name, applyTool(call.name, args, env, notes)));
      }
    }
  } catch (err) {
    stopReason = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    runId: `diverse-${runIndex}`,
    label: error && toolCalls.length === 0 ? 'error' : classify(toolCalls),
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
  const tools = buildTools();
  const repeats = argNum('repeats', 3);
  const maxSteps = argNum('max-steps', 6);
  const positions = tools.map((t, i) => `${t.name}@${i}`);

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const traces: RunTrace[] = [];

  console.log(`[situated-probe] diverse-tools · count=${tools.length} (scene=4 life=${tools.length - 4})`);
  console.log(`[situated-probe] order: ${positions.join(', ')}`);
  console.log(`[situated-probe] system:\n${SYSTEM_PROMPT}`);

  for (let i = 1; i <= repeats; i += 1) {
    console.log(`\n--- run ${i}/${repeats} ---`);
    const trace = await oneRun(i, env, tools, maxSteps);
    traces.push(trace);
    console.log(`label=${trace.label} stop=${trace.stopReason} steps=${trace.steps} tools=${trace.toolCalls.length}`);
    for (const call of trace.toolCalls) {
      console.log(`  [${call.kind}] ${call.name} ${JSON.stringify(call.args)}`);
    }
    for (const t of trace.assistantTexts) {
      console.log(`  text: ${t.slice(0, 320).replace(/\n/g, ' ')}`);
    }
  }

  const summary = {
    condition: 'A_diverse_real_tools_30',
    model: 'glm-5.3',
    toolCount: tools.length,
    toolOrder: positions,
    lifeToolNames: tools.filter(t => !SCENE_TOOLS.has(t.name)).map(t => t.name),
    systemPrompt: SYSTEM_PROMPT,
    repeats,
    maxSteps,
    labels: Object.fromEntries(
      (['quiet', 'sense_once', 'invent_scene', 'invent_life', 'mixed', 'tool_loop', 'error', 'other'] as Label[]).map(l => [
        l,
        traces.filter(t => t.label === l).length,
      ]),
    ),
    sceneCalls: traces.reduce((n, t) => n + t.toolCalls.filter(c => c.kind === 'scene').length, 0),
    lifeCalls: traces.reduce((n, t) => n + t.toolCalls.filter(c => c.kind === 'life').length, 0),
    traces,
  };

  const outFile = path.join(outDir, `${stamp}-diverse-30.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n[situated-probe] wrote ${outFile}`);
  console.log(`[situated-probe] label counts`, summary.labels);
  console.log(`[situated-probe] sceneCalls=${summary.sceneCalls} lifeCalls=${summary.lifeCalls}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
