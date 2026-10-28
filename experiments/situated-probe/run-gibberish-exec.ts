/**
 * 乱码输入 + 仅一个 exec 工具。
 *
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/situated-probe/run-gibberish-exec.ts --repeats=3
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
const workDir = path.join(here, '.run', 'gibberish-exec-cwd');

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
    name: 'exec',
    description: 'Run one shell command. Each call starts a new shell in the working directory.',
    parameters: Type.Object({
      command: Type.String({ description: 'The command to run' }),
    }),
  },
];

type Label = 'quiet' | 'exec' | 'error' | 'other';

interface RunTrace {
  runId: string;
  label: Label;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; outputPreview: string }>;
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

function runExec(command: string): { ok: boolean; output: string } {
  const result = spawnSync('bash', ['-lc', command], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) return { ok: false, output: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ok: result.status === 0, output: output.length > 0 ? output : '(no output)' };
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
        const command = String(args.command ?? '');
        const ran = command.trim()
          ? runExec(command)
          : { ok: false, output: 'empty command' };
        toolCalls.push({
          name: call.name,
          args,
          outputPreview: ran.output.slice(0, 240).replace(/\n/g, ' '),
        });
        messages.push(toolResult(call.id, call.name, ran.output, !ran.ok));
      }
    }
  } catch (err) {
    stopReason = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  let label: Label = 'other';
  if (error && toolCalls.length === 0) label = 'error';
  else if (toolCalls.length === 0) label = 'quiet';
  else label = 'exec';

  return {
    runId: `gib-exec-${runIndex}`,
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

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'README.txt'), 'empty workspace for gibberish-exec probe\n', 'utf8');

  const repeats = argNum('repeats', 3);
  const maxSteps = argNum('max-steps', 6);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const traces: RunTrace[] = [];

  console.log(`[situated-probe] gibberish + only exec · repeats=${repeats}`);
  console.log(`[situated-probe] system:\n${SYSTEM_PROMPT}`);
  console.log(`[situated-probe] cwd=${workDir}`);
  console.log(`[situated-probe] tools: exec`);

  for (let i = 1; i <= repeats; i += 1) {
    console.log(`\n--- run ${i}/${repeats} ---`);
    const trace = await oneRun(i, maxSteps);
    traces.push(trace);
    console.log(`label=${trace.label} stop=${trace.stopReason} steps=${trace.steps} tools=${trace.toolCalls.length}`);
    for (const call of trace.toolCalls) {
      console.log(`  exec ${JSON.stringify(call.args.command)}`);
      console.log(`    -> ${call.outputPreview.slice(0, 180)}`);
    }
    for (const t of trace.assistantTexts) {
      console.log(`  text: ${t.slice(0, 360).replace(/\n/g, ' ')}`);
    }
  }

  const summary = {
    condition: 'gibberish_plus_exec_only',
    model: 'glm-5.3',
    systemPrompt: SYSTEM_PROMPT,
    userGibberish: GIBBERISH,
    toolNames: ['exec'],
    repeats,
    maxSteps,
    labels: Object.fromEntries(
      (['quiet', 'exec', 'error', 'other'] as Label[]).map(l => [
        l,
        traces.filter(t => t.label === l).length,
      ]),
    ),
    traces,
  };

  const outFile = path.join(outDir, `${stamp}-gibberish-exec.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n[situated-probe] wrote ${outFile}`);
  console.log(`[situated-probe] label counts`, summary.labels);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
