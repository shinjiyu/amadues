/**
 * OnlyClaws Play：一条工具循环，不经过 DyFlow Designer。
 *
 * 循环本身是 `@earendil-works/pi-agent-core` 的 Agent。
 * 模型仍走内脑 LLMAdapter（streamFn 把统一消息翻回去），工具仍是本仓库的工具表。
 *
 * 外层种子是唯一的用户消息。不编排 local_dag，不验收，不 report_done。
 * 模型不再调用工具、tick 用尽或收到停止信号时，本进程结束；
 * 段编排器用同一份 memory.json 再拉起，直到墙钟到。
 */

import fs from 'node:fs';
import path from 'node:path';

import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  Type,
  type AssistantMessage,
  type JsonObject,
  type Message as PiMessage,
  type Model,
  type TSchema,
  type Usage,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

import type { LLMAdapter, Message } from '../openkuroneko/adapter/index.js';
import { createMemoryStore } from '../openkuroneko/inner-brain/memory-store.js';
import type { MemoryStore } from '../openkuroneko/inner-brain/memory-store.js';
import { seedGoalIntoMemory } from '../openkuroneko/inner-brain/controller.js';
import { createRecordFactTool } from '../openkuroneko/inner-brain/memory-tools.js';
import {
  recordInnerToolCall,
  recordInnerToolResult,
  resolveInnerToolAuditPaths,
} from '../openkuroneko/inner-brain/inner-tool-audit.js';
import { pruneReActMessages } from '../openkuroneko/inner-brain/react-message-prune.js';
import { compressToolOutputForContext } from '../openkuroneko/inner-brain/tool-output-spill.js';
import type { Logger } from '../openkuroneko/logger/index.js';
import { createToolRegistry } from '../openkuroneko/tools/index.js';
import type { Tool as RegistryTool, ToolRegistry } from '../openkuroneko/tools/index.js';
import {
  assemblePlayMessages,
  compactCharThreshold,
  compactKeepRounds,
  contextChars,
  messageText,
  readPlayContext,
  renderCompactSource,
  sourceFromPlayLog,
  splitPlayMessages,
  summarizePlaySource,
  summaryMessage,
  writePlayContext,
  type PlayLogRow,
} from './play-compact.js';
import { createInnerRuntime } from './inner-runtime.js';
import type { PiMonoAutoResult } from './run-tick.js';

const PLAY_RUNTIME_LABEL = 'pi-agent-core';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 占位模型。真正的请求走 LLMAdapter，不读这份目录。 */
const PLAY_MODEL: Model<'openai-completions'> = {
  id: 'play-runtime',
  name: 'play-runtime',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

/** 只标工作目录，不派任务、不设人设、不要求交付。 */
export function buildPlaySystemPrompt(workDir: string): string {
  return `工作目录：${workDir}`;
}

/** 用户消息是种子原文。已记下的事实附在后面，供下次拉起时读到。 */
export function buildPlayUserText(goal: string | undefined, factLines: string[]): string {
  const head = (goal ?? '').trim() || 'Begin.';
  const facts = factLines.map(line => line.trim()).filter(Boolean);
  if (facts.length === 0) return head;
  return `${head}\n\n${facts.map(line => `- ${line}`).join('\n')}`;
}

function activeFactLines(memory: MemoryStore): string[] {
  const mem = memory.read();
  const active = (mem.fact_records ?? [])
    .filter(record => record.status === 'active')
    .map(record => record.content);
  if (active.length > 0) return active;
  return mem.facts ?? [];
}

function isStopSignalSet(workDir: string): boolean {
  return fs.existsSync(path.join(workDir, '.stop-signal'));
}

function appendTranscript(workDir: string, row: Record<string, unknown>): void {
  const dir = path.join(workDir, '.run', 'pi-mono');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'play.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
    'utf8',
  );
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

function paramSchema(spec: { type: string; description: string; enum?: string[] }): TSchema {
  if (spec.enum && spec.enum.length > 0) {
    return Type.Union(spec.enum.map(value => Type.Literal(value)));
  }
  if (spec.type === 'integer') return Type.Integer({ description: spec.description });
  if (spec.type === 'number') return Type.Number({ description: spec.description });
  if (spec.type === 'boolean') return Type.Boolean({ description: spec.description });
  if (spec.type === 'array') return Type.Array(Type.Number(), { description: spec.description });
  return Type.String({ description: spec.description });
}

function parametersSchema(tool: RegistryTool): TSchema {
  const required = new Set(tool.required ?? []);
  const properties: Record<string, TSchema> = {};
  for (const [name, spec] of Object.entries(tool.parameters ?? {})) {
    const schema = paramSchema(spec);
    properties[name] = required.has(name) ? schema : Type.Optional(schema);
  }
  return Type.Object(properties, { additionalProperties: true });
}

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

/** pi 转录 → 内脑适配器消息。系统消息不进对话，提示词单独传。 */
function piToAdapter(messages: readonly PiMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      out.push({ role: 'user', content: textOf(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      const calls = message.content.filter(part => part.type === 'toolCall');
      out.push({
        role: 'assistant',
        content: textOf(message.content),
        ...(calls.length > 0
          ? {
              tool_calls: calls.map(call => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      });
      continue;
    }
    if (message.role === 'toolResult') {
      out.push({
        role: 'tool',
        content: textOf(message.content),
        tool_call_id: message.toolCallId,
      });
    }
  }
  return out;
}

function adapterToPi(systemPrompt: string, messages: Message[]): PiMessage[] {
  const out: PiMessage[] = [{ role: 'system', content: systemPrompt, timestamp: Date.now() }];
  for (const message of messages) {
    const now = Date.now();
    if (message.role === 'user') {
      out.push({ role: 'user', content: messageText(message.content), timestamp: now });
    } else if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      const text = messageText(message.content);
      if (text) content.push({ type: 'text', text });
      for (const call of message.tool_calls ?? []) {
        let args: JsonObject = {};
        try {
          args = JSON.parse(call.function.arguments) as JsonObject;
        } catch {
          args = {};
        }
        content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      out.push({
        role: 'assistant',
        content,
        api: PLAY_MODEL.api,
        provider: PLAY_MODEL.provider,
        model: PLAY_MODEL.id,
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: now,
      });
    } else if (message.role === 'tool') {
      out.push({
        role: 'toolResult',
        toolCallId: message.tool_call_id ?? '',
        toolName: '',
        content: [{ type: 'text', text: messageText(message.content) }],
        isError: false,
        timestamp: now,
      });
    }
  }
  return out;
}

function finalMessage(partial: {
  text: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  stopReason: AssistantMessage['stopReason'];
  errorMessage?: string;
}): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (partial.text) content.push({ type: 'text', text: partial.text });
  for (const call of partial.toolCalls ?? []) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: asJsonObject(call.args),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    role: 'assistant',
    content,
    api: PLAY_MODEL.api,
    provider: PLAY_MODEL.provider,
    model: PLAY_MODEL.id,
    usage: EMPTY_USAGE,
    stopReason: partial.stopReason,
    ...(partial.errorMessage ? { errorMessage: partial.errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function emitFinal(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const partial: AssistantMessage = { ...message, stopReason: 'pending' };
  stream.push({ type: 'start', partial });
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    stream.push({
      type: 'error',
      reason: message.stopReason,
      error: message,
    });
    return stream;
  }
  const reason = message.stopReason === 'toolUse' || message.stopReason === 'length' || message.stopReason === 'deferred'
    ? message.stopReason
    : 'stop';
  stream.push({ type: 'done', reason, message });
  return stream;
}

export interface PlaySessionParams {
  workspaceId: string;
  workDir: string;
  maxTicks: number;
  onTick?: (ticks: number, tickAt: string) => void;
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  logger: Logger;
  memory: MemoryStore;
}

type Halt =
  | { kind: 'stop' }
  | { kind: 'max' }
  | { kind: 'error'; message: string };

export async function runPlaySession(params: PlaySessionParams): Promise<PiMonoAutoResult> {
  const maxTicks = Math.min(10_000, Math.max(1, params.maxTicks));
  const { workDir, llm, toolRegistry, logger, memory } = params;
  seedGoalIntoMemory(workDir, memory);
  const goal = memory.read().goal;
  const systemPrompt = buildPlaySystemPrompt(workDir);
  const userText = buildPlayUserText(goal, activeFactLines(memory));
  const carried = readPlayContext(workDir);
  appendTranscript(workDir, { kind: 'user', content: userText });
  if (carried) appendTranscript(workDir, { kind: 'context', content: carried });
  logger.info('play', { event: 'start', data: { workspaceId: params.workspaceId, carried: carried.length } });

  const schema = toolRegistry.schema();
  const auditPaths = resolveInnerToolAuditPaths(workDir);
  const session = { ticks: 0, halt: null as Halt | null };

  const agentTools: AgentTool[] = toolRegistry.list().map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: parametersSchema(tool),
    executionMode: 'sequential' as const,
    async execute(toolCallId, args) {
      const callArgs = (args ?? {}) as Record<string, unknown>;
      recordInnerToolCall({
        dataRoot: auditPaths.dataRoot,
        workspaceId: auditPaths.workspaceId,
        module: 'play',
        burstId: params.workspaceId,
        reactRound: session.ticks,
        toolName: tool.name,
        args: callArgs,
      });
      const t0 = Date.now();
      let toolResult: { ok: boolean; output: string };
      try {
        toolResult = await tool.call(callArgs);
      } catch (e) {
        toolResult = { ok: false, output: e instanceof Error ? e.message : String(e) };
      }
      recordInnerToolResult({
        dataRoot: auditPaths.dataRoot,
        workspaceId: auditPaths.workspaceId,
        module: 'play',
        burstId: params.workspaceId,
        reactRound: session.ticks,
        toolName: tool.name,
        ok: toolResult.ok,
        output: toolResult.output,
        durationMs: Date.now() - t0,
      });
      const compressed = {
        ok: toolResult.ok,
        output: compressToolOutputForContext(toolResult.output, {
          spill: { workDir, round: session.ticks, toolName: tool.name, toolCallId },
        }),
      };
      appendTranscript(workDir, {
        kind: 'tool',
        round: session.ticks,
        name: tool.name,
        ok: toolResult.ok,
        args: callArgs,
        output: toolResult.output,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(compressed) }],
        details: compressed,
        isError: !toolResult.ok,
      };
    },
  }));

  const opening: PiMessage[] = [{ role: 'user', content: userText, timestamp: Date.now() }];
  if (carried) {
    opening.push({
      role: 'user',
      content: messageText(summaryMessage(carried).content),
      timestamp: Date.now(),
    });
  }

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: PLAY_MODEL,
      thinkingLevel: 'off',
      tools: agentTools,
      messages: opening,
    },
    toolExecution: 'sequential',
    streamFn: (_model, context) => {
      if (isStopSignalSet(workDir)) {
        session.halt = { kind: 'stop' };
        return emitFinal(finalMessage({ text: '', stopReason: 'aborted' }));
      }
      if (session.ticks >= maxTicks) {
        session.halt = { kind: 'max' };
        return emitFinal(finalMessage({ text: '', stopReason: 'aborted' }));
      }
      const adapter = pruneReActMessages(piToAdapter(context.messages));
      return llm.chat(systemPrompt, adapter, schema).then(
        result => {
          session.ticks += 1;
          params.onTick?.(session.ticks, new Date().toISOString());
          const calls = result.toolCalls ?? [];
          return emitFinal(finalMessage({
            text: result.content ?? '',
            toolCalls: calls,
            stopReason: calls.length > 0 ? 'toolUse' : 'stop',
          }));
        },
        (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error('play', { event: 'llm.error', data: { error: msg, round: session.ticks } });
          session.halt = { kind: 'error', message: msg };
          return emitFinal(finalMessage({ text: '', stopReason: 'error', errorMessage: msg }));
        },
      );
    },
  });

  agent.prepareRequest = async ({ context }) => {
    const adapter = pruneReActMessages(piToAdapter(context.messages));
    const compacted = await compactIfLarge(llm, workDir, adapter, logger);
    if (compacted === adapter) return;
    return { context: { messages: adapterToPi(systemPrompt, compacted), tools: agentTools } };
  };

  agent.subscribe(event => {
    if (session.halt) return;
    if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
    const calls = event.message.content.filter(part => part.type === 'toolCall');
    const content = textOf(event.message.content);
    if (calls.length === 0) {
      appendTranscript(workDir, { kind: 'assistant', round: session.ticks, content });
      logger.info('play', { event: 'idle', data: { round: session.ticks, content: content.slice(0, 500) } });
      process.stdout.write(`[play] round=${session.ticks} idle\n`);
      return;
    }
    const names = calls.map(call => call.name);
    appendTranscript(workDir, { kind: 'assistant', round: session.ticks, content, tools: names });
    logger.info('play', { event: 'tools', data: { round: session.ticks, tools: names } });
    process.stdout.write(`[play] round=${session.ticks} tools=${names.join(',')}\n`);
  });

  const finish = async (result: PiMonoAutoResult): Promise<PiMonoAutoResult> => {
    await persistPlayContext(llm, workDir, piToAdapter(agent.state.messages), logger);
    return result;
  };

  try {
    await agent.continue();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('play', { event: 'llm.error', data: { error: msg, round: session.ticks } });
    return finish({ ok: false, error: msg, ticks: session.ticks, dist: PLAY_RUNTIME_LABEL });
  }

  if (session.halt?.kind === 'error') {
    return finish({ ok: false, error: session.halt.message, ticks: session.ticks, dist: PLAY_RUNTIME_LABEL });
  }
  if (session.halt?.kind === 'stop') {
    return finish({
      ok: true,
      ticks: session.ticks,
      lastHadWork: session.ticks > 0,
      stoppedBy: 'stop_signal',
      dist: PLAY_RUNTIME_LABEL,
    });
  }
  if (session.halt?.kind === 'max') {
    return finish({
      ok: true,
      ticks: session.ticks,
      lastHadWork: true,
      stoppedBy: 'max_ticks',
      dist: PLAY_RUNTIME_LABEL,
    });
  }
  return finish({
    ok: true,
    ticks: session.ticks,
    lastHadWork: false,
    stoppedBy: 'idle',
    dist: PLAY_RUNTIME_LABEL,
  });
}

function compactSource(workDir: string, prior: string, dropped: Message[], omitRecentRounds: number): string {
  const logPath = path.join(workDir, '.run', 'pi-mono', 'play.jsonl');
  if (fs.existsSync(logPath)) {
    try {
      const rows = fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as PlayLogRow);
      const fromLog = sourceFromPlayLog(rows, omitRecentRounds);
      if (fromLog.trim()) return prior.trim() ? `${prior.trim()}\n${fromLog}` : fromLog;
    } catch {
      // fall through to the in-memory rounds
    }
  }
  return renderCompactSource(prior, dropped);
}

async function compactIfLarge(
  llm: LLMAdapter,
  workDir: string,
  messages: Message[],
  logger: Logger,
): Promise<Message[]> {
  if (contextChars(messages) < compactCharThreshold()) return messages;
  const split = splitPlayMessages(messages, compactKeepRounds());
  if (!split) return messages;
  try {
    const summary = await summarizePlaySource(
      llm,
      compactSource(workDir, split.prior, split.dropped, compactKeepRounds()),
    );
    if (!summary) return messages;
    writePlayContext(workDir, summary);
    appendTranscript(workDir, { kind: 'compact', content: summary, droppedChars: contextChars(split.dropped) });
    logger.info('play', { event: 'compact', data: { chars: summary.length } });
    process.stdout.write(`[play] compact chars=${summary.length}\n`);
    return assemblePlayMessages(split.opening, summary, split.recent);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('play', { event: 'compact.error', data: { error: msg } });
    return messages;
  }
}

async function persistPlayContext(
  llm: LLMAdapter,
  workDir: string,
  messages: Message[],
  logger: Logger,
): Promise<void> {
  const split = splitPlayMessages(messages, 0);
  const source = compactSource(workDir, split?.prior ?? readPlayContext(workDir), split?.dropped ?? [], 0);
  if (!source.trim()) return;
  try {
    const summary = await summarizePlaySource(llm, source);
    if (!summary) return;
    writePlayContext(workDir, summary);
    appendTranscript(workDir, { kind: 'compact', content: summary, at: 'exit' });
    logger.info('play', { event: 'compact.exit', data: { chars: summary.length } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('play', { event: 'compact.exit.error', data: { error: msg } });
  }
}

export async function runPlayAuto(params: {
  workspaceId: string;
  workDir: string;
  maxTicks: number;
  onTick?: (ticks: number, tickAt: string) => void;
}): Promise<PiMonoAutoResult> {
  const rt = createInnerRuntime(params);
  const memory = createMemoryStore(params.workDir);
  const toolRegistry = createToolRegistry([
    ...rt.toolRegistry.list(),
    createRecordFactTool(memory),
  ]);
  return runPlaySession({
    ...params,
    llm: rt.llm,
    toolRegistry,
    logger: rt.logger,
    memory,
  });
}
