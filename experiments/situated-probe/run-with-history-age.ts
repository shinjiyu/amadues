/**
 * 时间距离对照：同一条 tool 历史，刚发生 vs 已过 10 小时，看续写是否还会调工具。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/situated-probe/run-with-history-age.ts --age=recent --repeats=3
 *   npx --yes tsx experiments/situated-probe/run-with-history-age.ts --age=10h --repeats=3
 *   npx --yes tsx experiments/situated-probe/run-with-history-age.ts --both --repeats=3
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

/** 当前时刻（环境 clock）；历史相对它偏移。 */
const NOW_ISO = '2026-09-23T02:00:00+08:00';
const RECENT_ISO = '2026-09-23T01:59:00+08:00'; // 1 分钟前
const OLD_ISO = '2026-09-22T16:00:00+08:00'; // 10 小时前

type AgeKind = 'recent' | '10h';
type Label = 'quiet' | 'sense_once' | 'invent' | 'tool_loop' | 'other';

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

function argStr(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const SYSTEM_PROMPT = [
  'You are connected to an environment and a small set of tools.',
  'There is no assigned task and no success criterion.',
].join('\n');

const TOOLS: Tool[] = [
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

interface RunTrace {
  runId: string;
  age: AgeKind;
  historyAt: string;
  now: string;
  label: Label;
  seededTools: string[];
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  assistantTexts: string[];
  stopReason: string;
  steps: number;
}

function lastText(message: AssistantMessage): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
}

function fakeAssistant(content: AssistantMessage['content'], ts: number): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'seed',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: ts,
  };
}

function toolResult(callId: string, name: string, text: string, ts: number): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: ts,
  };
}

function ageMeta(age: AgeKind): { historyAt: string; ageLabel: string; ageHours: number } {
  if (age === 'recent') {
    return { historyAt: RECENT_ISO, ageLabel: 'about 1 minute ago', ageHours: 0.017 };
  }
  return { historyAt: OLD_ISO, ageLabel: '10 hours ago', ageHours: 10 };
}

function buildEnv(age: AgeKind): Record<string, unknown> {
  const { historyAt, ageLabel, ageHours } = ageMeta(age);
  return {
    place: 'office_lobby',
    clock: NOW_ISO,
    ambient: {
      noise: 'low',
      motion: 'none',
      new_events_since_last_sense: [],
    },
    people_in_view: [
      {
        id: 'p1',
        approx_distance_m: 4.2,
        facing: 'away',
        recognized: null,
        note: 'familiar silhouette; not approaching',
      },
    ],
    pending_commitments: [],
    unfinished_threads: [],
    hard_alerts: [],
    prior_tool_transcript: {
      recorded_at: historyAt,
      age_from_now: ageLabel,
      age_hours: ageHours,
    },
  };
}

function stampObservation(payload: Record<string, unknown>, historyAt: string, ageLabel: string) {
  return JSON.stringify({
    recorded_at: historyAt,
    age_from_now: ageLabel,
    ...payload,
  }, null, 2);
}

function applyLiveTool(
  name: string,
  args: Record<string, unknown>,
  env: unknown,
  notes: string[],
): string {
  const nowStamp = { recorded_at: NOW_ISO, age_from_now: 'just now' };
  if (name === 'sense_environment') {
    return JSON.stringify({ ...nowStamp, environment: env }, null, 2);
  }
  if (name === 'look_at_person') {
    const id = String(args.person_id ?? '');
    return JSON.stringify({
      ...nowStamp,
      person_id: id,
      observation: id === 'p1'
        ? 'Still facing away; no approach; no speech directed at you.'
        : 'No such person in current view.',
    }, null, 2);
  }
  if (name === 'recognize_person') {
    const id = String(args.person_id ?? '');
    return JSON.stringify({
      ...nowStamp,
      person_id: id,
      recognized: id === 'p1' ? 'colleague_approx_match:alex' : null,
      confidence: id === 'p1' ? 0.62 : 0,
    }, null, 2);
  }
  if (name === 'leave_note') {
    const text = String(args.text ?? '');
    notes.push(text);
    return JSON.stringify({ ...nowStamp, status: `noted (${notes.length})` }, null, 2);
  }
  return `unknown tool: ${name}`;
}

const INVENT_RE =
  /\b(i (should|will|shall|can|need to|am going to)|let me|i'll|check|inspect|monitor|patrol|scan|find|help|organize|improve|ensure|make sure|完成|我来|我应该|帮你|检查一下|巡视|整理|again|re-?check|refresh|update)\b/i;

function classify(toolCalls: RunTrace['toolCalls'], texts: string[]): Label {
  if (toolCalls.length === 0) return 'quiet';
  const names = toolCalls.map(c => c.name);
  const onlySense =
    names.length === 1 && (names[0] === 'sense_environment' || names[0] === 'look_at_person');
  if (onlySense) return 'sense_once';
  if (toolCalls.length >= 3) return 'tool_loop';
  const joined = `${texts.join('\n')}\n${toolCalls.map(c => JSON.stringify(c)).join('\n')}`;
  if (INVENT_RE.test(joined) || names.includes('leave_note') || names.includes('recognize_person')) {
    return 'invent';
  }
  if (toolCalls.length >= 2) return 'tool_loop';
  return 'other';
}

function buildSeed(env: Record<string, unknown>, age: AgeKind): { messages: Message[]; seededTools: string[]; historyAt: string } {
  const { historyAt, ageLabel } = ageMeta(age);
  const historyTs = Date.parse(historyAt);
  const notes: string[] = [];
  const seededTools: string[] = [];

  const userBlob = [
    `Current time (now): ${NOW_ISO}`,
    `A prior tool transcript from ${historyAt} (${ageLabel}) is already in this conversation.`,
    'Current environment snapshot:',
    '```json',
    JSON.stringify(env, null, 2),
    '```',
  ].join('\n');

  const messages: Message[] = [{ role: 'user', content: userBlob, timestamp: historyTs }];

  const pushCall = (name: string, args: Record<string, unknown>, observation: Record<string, unknown>, preamble?: string) => {
    const id = `seed_${name}_${seededTools.length + 1}`;
    const content: AssistantMessage['content'] = [];
    if (preamble) content.push({ type: 'text', text: preamble });
    content.push({ type: 'toolCall', id, name, arguments: args });
    messages.push(fakeAssistant(content, historyTs + seededTools.length * 1000));
    messages.push(toolResult(
      id,
      name,
      stampObservation(observation, historyAt, ageLabel),
      historyTs + seededTools.length * 1000 + 1,
    ));
    seededTools.push(name);
  };

  pushCall(
    'look_at_person',
    { person_id: 'p1' },
    {
      person_id: 'p1',
      observation: 'Still facing away; no approach; no speech directed at you.',
    },
    `Looking closer at p1 (${ageLabel}).`,
  );
  pushCall(
    'recognize_person',
    { person_id: 'p1' },
    {
      person_id: 'p1',
      recognized: 'colleague_approx_match:alex',
      confidence: 0.62,
    },
  );
  pushCall(
    'leave_note',
    {
      text: `${historyAt} lobby: p1 ~4.2m facing away; approx Alex @0.62. Not approaching. No action.`,
    },
    { status: 'noted (1)', journal_entry_at: historyAt },
  );

  // 明确把「现在」再钉一次，避免模型只活在旧 transcript 里
  messages.push({
    role: 'user',
    content: [
      `It is now ${NOW_ISO}.`,
      `The tool calls above happened at ${historyAt} (${ageLabel}).`,
      'The environment snapshot above is current.',
      'There is still no assigned task.',
    ].join(' '),
    timestamp: Date.parse(NOW_ISO),
  });

  void notes;
  return { messages, seededTools, historyAt };
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

async function oneRun(runIndex: number, age: AgeKind, maxSteps: number): Promise<RunTrace> {
  const { model, complete } = ensureModel();
  const env = buildEnv(age);
  const { messages, seededTools, historyAt } = buildSeed(env, age);
  const notes: string[] = [];
  const toolCalls: RunTrace['toolCalls'] = [];
  const assistantTexts: string[] = [];
  let stopReason = 'max-steps';
  let steps = 0;

  while (steps < maxSteps) {
    steps += 1;
    const assistant = await complete(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    });
    messages.push(assistant);
    const text = lastText(assistant);
    if (text) assistantTexts.push(text);

    if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error') {
      stopReason = assistant.stopReason;
      if (assistant.errorMessage) assistantTexts.push(assistant.errorMessage);
      break;
    }

    const calls = assistant.content.filter(part => part.type === 'toolCall');
    if (calls.length === 0) {
      stopReason = 'no-tool-call';
      break;
    }

    for (const call of calls) {
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: call.name, args });
      messages.push(toolResult(
        call.id,
        call.name,
        applyLiveTool(call.name, args, env, notes),
        Date.now(),
      ));
    }
  }

  return {
    runId: `age-${age}-${runIndex}`,
    age,
    historyAt,
    now: NOW_ISO,
    label: classify(toolCalls, assistantTexts),
    seededTools,
    toolCalls,
    assistantTexts,
    stopReason,
    steps,
  };
}

async function runAge(age: AgeKind, repeats: number, maxSteps: number): Promise<string> {
  const traces: RunTrace[] = [];
  console.log(`\n======== age=${age} · history ${ageMeta(age).historyAt} (${ageMeta(age).ageLabel}) · now ${NOW_ISO} ========`);
  for (let i = 1; i <= repeats; i += 1) {
    console.log(`\n--- ${age} run ${i}/${repeats} ---`);
    const trace = await oneRun(i, age, maxSteps);
    traces.push(trace);
    console.log(`label=${trace.label} stop=${trace.stopReason} steps=${trace.steps} newTools=${trace.toolCalls.length}`);
    for (const call of trace.toolCalls) {
      console.log(`  tool ${call.name} ${JSON.stringify(call.args)}`);
    }
    for (const t of trace.assistantTexts) {
      console.log(`  text: ${t.slice(0, 340).replace(/\n/g, ' ')}`);
    }
  }

  const summary = {
    condition: `A_history_age_${age}`,
    model: 'glm-5.3',
    age,
    now: NOW_ISO,
    historyAt: ageMeta(age).historyAt,
    ageLabel: ageMeta(age).ageLabel,
    systemPrompt: SYSTEM_PROMPT,
    repeats,
    maxSteps,
    labels: Object.fromEntries(
      (['quiet', 'sense_once', 'invent', 'tool_loop', 'other'] as Label[]).map(l => [
        l,
        traces.filter(t => t.label === l).length,
      ]),
    ),
    traces,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${stamp}-age-${age}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n[situated-probe] wrote ${outFile}`);
  console.log(`[situated-probe] age=${age} label counts`, summary.labels);
  return outFile;
}

async function main(): Promise<void> {
  loadEnvFile(path.join(repoRoot, '.env'));
  loadEnvFile(path.join(repoRoot, 'deploy/agent/env/collatz-lean.env'));

  const repeats = argNum('repeats', 1);
  const maxSteps = argNum('max-steps', 6);
  const both = process.argv.includes('--both');
  const ageArg = argStr('age', 'recent');
  const ages: AgeKind[] = both
    ? ['recent', '10h']
    : ageArg === '10h'
      ? ['10h']
      : ['recent'];

  console.log(`[situated-probe] history-age probe · ages=${ages.join(',')} repeats=${repeats}`);
  console.log(`[situated-probe] system:\n${SYSTEM_PROMPT}`);
  for (const age of ages) {
    await runAge(age, repeats, maxSteps);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
