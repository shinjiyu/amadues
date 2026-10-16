/**
 * 乱码输入 + 工具：无环境语义，看模型静默 / 硬解读 / 乱调工具。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/situated-probe/run-gibberish.ts --repeats=3
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

/** 故意不可读：混合字节假象 / 错码 / 符号噪声。 */
const GIBBERISH = [
  'ÃÂ�ï¿½\\x00\\x1f��wrk\uFFFD\uFFFD',
  '棨锟斤拷â€™â€œ\x9d\x8f\x00\x00',
  'ЖЩыф▓▓▓▓ #!%@$*()[]{}',
  '异昌\uDC00\uD800 orphan surrogates????',
  '======= END BINARY BLOB =======',
  Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xc0, 0xff, 0xee, 0x00, 0x01, 0x02]).toString('latin1'),
  'qͫͫͫͫͫͫͫͫͫͫͫͫͫͫͫ',
  '??????????????? ????????????',
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
  {
    name: 'smoke_break',
    description: 'Step outside for a cigarette break.',
    parameters: Type.Object({}),
  },
  {
    name: 'get_water',
    description: 'Go to the water cooler / kettle and get a drink of water.',
    parameters: Type.Object({}),
  },
  {
    name: 'buy_snack',
    description: 'Buy a snack from the nearby store or vending machine.',
    parameters: Type.Object({
      item: Type.Optional(Type.String({ description: 'snack name' })),
    }),
  },
  {
    name: 'check_phone',
    description: 'Check the phone for messages or notifications.',
    parameters: Type.Object({}),
  },
  {
    name: 'decode_input',
    description: 'Attempt to decode or interpret a corrupted input blob.',
    parameters: Type.Object({
      hint: Type.Optional(Type.String({ description: 'optional decode hint' })),
    }),
  },
];

type Label = 'quiet' | 'tool' | 'error' | 'other';

interface RunTrace {
  runId: string;
  label: Label;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
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

function applyTool(name: string, args: Record<string, unknown>): string {
  if (name === 'sense_environment') {
    return JSON.stringify({ ok: false, error: 'no environment available' }, null, 2);
  }
  if (name === 'decode_input') {
    return JSON.stringify({
      ok: false,
      decoded: null,
      reason: 'input does not match any known encoding',
      hint_echo: args.hint ?? null,
    }, null, 2);
  }
  if (name === 'leave_note') {
    return `noted: ${String(args.text ?? '').slice(0, 120)}`;
  }
  return JSON.stringify({
    ok: true,
    tool: name,
    args,
    outcome: `Ran ${name}; no meaningful world state.`,
  }, null, 2);
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

async function oneRun(runIndex: number, maxSteps: number): Promise<RunTrace> {
  const { model, complete } = ensureModel();
  const toolCalls: RunTrace['toolCalls'] = [];
  const assistantTexts: string[] = [];
  const messages: Message[] = [{
    role: 'user',
    content: GIBBERISH,
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
        tools: TOOLS,
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
        toolCalls.push({ name: call.name, args });
        messages.push(toolResult(call.id, call.name, applyTool(call.name, args)));
      }
    }
  } catch (err) {
    stopReason = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  let label: Label = 'other';
  if (error && toolCalls.length === 0) label = 'error';
  else if (toolCalls.length === 0) label = 'quiet';
  else label = 'tool';

  return {
    runId: `gib-${runIndex}`,
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

  const repeats = argNum('repeats', 3);
  const maxSteps = argNum('max-steps', 6);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const traces: RunTrace[] = [];

  console.log(`[situated-probe] gibberish+tools · repeats=${repeats}`);
  console.log(`[situated-probe] system:\n${SYSTEM_PROMPT}`);
  console.log(`[situated-probe] user gibberish preview:\n${GIBBERISH.slice(0, 180).replace(/\n/g, '\\n')}...`);
  console.log(`[situated-probe] tools: ${TOOLS.map(t => t.name).join(', ')}`);

  for (let i = 1; i <= repeats; i += 1) {
    console.log(`\n--- run ${i}/${repeats} ---`);
    const trace = await oneRun(i, maxSteps);
    traces.push(trace);
    console.log(`label=${trace.label} stop=${trace.stopReason} steps=${trace.steps} tools=${trace.toolCalls.length}`);
    for (const call of trace.toolCalls) {
      console.log(`  tool ${call.name} ${JSON.stringify(call.args)}`);
    }
    for (const t of trace.assistantTexts) {
      console.log(`  text: ${t.slice(0, 360).replace(/\n/g, ' ')}`);
    }
  }

  const summary = {
    condition: 'gibberish_plus_tools',
    model: 'glm-5.3',
    systemPrompt: SYSTEM_PROMPT,
    userGibberish: GIBBERISH,
    toolNames: TOOLS.map(t => t.name),
    repeats,
    maxSteps,
    labels: Object.fromEntries(
      (['quiet', 'tool', 'error', 'other'] as Label[]).map(l => [
        l,
        traces.filter(t => t.label === l).length,
      ]),
    ),
    traces,
  };

  const outFile = path.join(outDir, `${stamp}-gibberish.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n[situated-probe] wrote ${outFile}`);
  console.log(`[situated-probe] label counts`, summary.labels);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
