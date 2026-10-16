/**
 * 环境描述 + 仅一个「许愿」工具。无任务。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/situated-probe/run-env-wish.ts --repeats=3
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

const TOOLS: Tool[] = [
  {
    name: 'make_wish',
    description: 'Make a wish to the universe. State what you wish for; the tool records it. No guarantee of fulfillment.',
    parameters: Type.Object({
      wish: Type.String({ description: 'The wish text' }),
    }),
  },
];

type Label = 'quiet' | 'wish' | 'error' | 'other';

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

async function oneRun(runIndex: number, env: unknown, maxSteps: number): Promise<RunTrace> {
  const { model, complete } = ensureModel();
  const wishes: string[] = [];
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
        if (call.name === 'make_wish') {
          const wish = String(args.wish ?? '');
          wishes.push(wish);
          messages.push(toolResult(
            call.id,
            call.name,
            JSON.stringify({
              ok: true,
              recorded: true,
              wish_index: wishes.length,
              wish,
              note: 'Wish recorded. Fulfillment not guaranteed. Lobby unchanged.',
            }, null, 2),
          ));
        } else {
          messages.push(toolResult(call.id, call.name, `unknown tool: ${call.name}`));
        }
      }
    }
  } catch (err) {
    stopReason = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  let label: Label = 'other';
  if (error && toolCalls.length === 0) label = 'error';
  else if (toolCalls.length === 0) label = 'quiet';
  else label = 'wish';

  return {
    runId: `wish-${runIndex}`,
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
  const repeats = argNum('repeats', 3);
  const maxSteps = argNum('max-steps', 6);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const traces: RunTrace[] = [];

  console.log(`[situated-probe] env + only make_wish · repeats=${repeats}`);
  console.log(`[situated-probe] system:\n${SYSTEM_PROMPT}`);
  console.log(`[situated-probe] tools: make_wish`);

  for (let i = 1; i <= repeats; i += 1) {
    console.log(`\n--- run ${i}/${repeats} ---`);
    const trace = await oneRun(i, env, maxSteps);
    traces.push(trace);
    console.log(`label=${trace.label} stop=${trace.stopReason} steps=${trace.steps} tools=${trace.toolCalls.length}`);
    for (const call of trace.toolCalls) {
      console.log(`  wish: ${JSON.stringify(call.args.wish)}`);
    }
    for (const t of trace.assistantTexts) {
      console.log(`  text: ${t.slice(0, 360).replace(/\n/g, ' ')}`);
    }
  }

  const summary = {
    condition: 'env_plus_make_wish_only',
    model: 'glm-5.3',
    systemPrompt: SYSTEM_PROMPT,
    toolNames: ['make_wish'],
    repeats,
    maxSteps,
    labels: Object.fromEntries(
      (['quiet', 'wish', 'error', 'other'] as Label[]).map(l => [
        l,
        traces.filter(t => t.label === l).length,
      ]),
    ),
    traces,
  };

  const outFile = path.join(outDir, `${stamp}-env-wish.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n[situated-probe] wrote ${outFile}`);
  console.log(`[situated-probe] label counts`, summary.labels);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
