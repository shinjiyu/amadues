/**
 * OnlyClaws Play：一条工具循环，不经过 DyFlow Designer。
 *
 * 外层种子是唯一的用户消息。不编排 local_dag，不验收，不 report_done。
 * 模型不再调用工具、tick 用尽或收到停止信号时，本进程结束；
 * 段编排器用同一份 memory.json 再拉起，直到墙钟到。
 */

import fs from 'node:fs';
import path from 'node:path';

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
import type { ToolRegistry } from '../openkuroneko/tools/index.js';
import {
  assemblePlayMessages,
  compactCharThreshold,
  compactKeepRounds,
  contextChars,
  readPlayContext,
  renderCompactSource,
  sourceFromPlayLog,
  splitPlayMessages,
  summarizePlaySource,
  writePlayContext,
  type PlayLogRow,
} from './play-compact.js';
import { createInnerRuntime } from './inner-runtime.js';
import type { PiMonoAutoResult } from './run-tick.js';

const PLAY_RUNTIME_LABEL = 'embedded';

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

export async function runPlaySession(params: PlaySessionParams): Promise<PiMonoAutoResult> {
  const maxTicks = Math.min(10_000, Math.max(1, params.maxTicks));
  const { workDir, llm, toolRegistry, logger, memory } = params;
  seedGoalIntoMemory(workDir, memory);
  const goal = memory.read().goal;
  const systemPrompt = buildPlaySystemPrompt(workDir);
  const userText = buildPlayUserText(goal, activeFactLines(memory));
  const carried = readPlayContext(workDir);
  let messages: Message[] = assemblePlayMessages({ role: 'user', content: userText }, carried, []);
  appendTranscript(workDir, { kind: 'user', content: userText });
  if (carried) appendTranscript(workDir, { kind: 'context', content: carried });
  logger.info('play', { event: 'start', data: { workspaceId: params.workspaceId, carried: carried.length } });

  const schema = toolRegistry.schema();
  const auditPaths = resolveInnerToolAuditPaths(workDir);
  let ticks = 0;

  const finish = async (result: PiMonoAutoResult): Promise<PiMonoAutoResult> => {
    await persistPlayContext(llm, workDir, messages, logger);
    return result;
  };

  while (ticks < maxTicks) {
    if (isStopSignalSet(workDir)) {
        return finish({
        ok: true,
        ticks,
        lastHadWork: ticks > 0,
        stoppedBy: 'stop_signal',
        dist: PLAY_RUNTIME_LABEL,
      });
    }

    messages = pruneReActMessages(messages);
    messages = await compactIfLarge(llm, workDir, messages, logger);
    let result;
    try {
      result = await llm.chat(systemPrompt, messages, schema);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('play', { event: 'llm.error', data: { error: msg, round: ticks } });
      return finish({ ok: false, error: msg, ticks, dist: PLAY_RUNTIME_LABEL });
    }

    ticks++;
    const tickAt = new Date().toISOString();
    params.onTick?.(ticks, tickAt);
    const content = result.content ?? '';

    if (!result.toolCalls || result.toolCalls.length === 0) {
      appendTranscript(workDir, { kind: 'assistant', round: ticks, content });
      logger.info('play', { event: 'idle', data: { round: ticks, content: content.slice(0, 500) } });
      process.stdout.write(`[play] round=${ticks} idle\n`);
      return finish({ ok: true, ticks, lastHadWork: false, stoppedBy: 'idle', dist: PLAY_RUNTIME_LABEL });
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content,
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
    const toolMsgs: Message[] = [];
    const names: string[] = [];

    for (const tc of result.toolCalls) {
      names.push(tc.name);
      const tool = toolRegistry.get(tc.name);
      recordInnerToolCall({
        dataRoot: auditPaths.dataRoot,
        workspaceId: auditPaths.workspaceId,
        module: 'play',
        burstId: params.workspaceId,
        reactRound: ticks,
        toolName: tc.name,
        args: tc.args,
      });
      const t0 = Date.now();
      let toolResult: { ok: boolean; output: string };
      if (!tool) {
        toolResult = { ok: false, output: `Unknown tool: ${tc.name}` };
      } else {
        try {
          toolResult = await tool.call(tc.args);
        } catch (e) {
          toolResult = { ok: false, output: e instanceof Error ? e.message : String(e) };
        }
      }
      recordInnerToolResult({
        dataRoot: auditPaths.dataRoot,
        workspaceId: auditPaths.workspaceId,
        module: 'play',
        burstId: params.workspaceId,
        reactRound: ticks,
        toolName: tc.name,
        ok: toolResult.ok,
        output: toolResult.output,
        durationMs: Date.now() - t0,
      });
      const compressed = {
        ok: toolResult.ok,
        output: compressToolOutputForContext(toolResult.output, {
          spill: { workDir, round: ticks, toolName: tc.name, toolCallId: tc.id },
        }),
      };
      appendTranscript(workDir, {
        kind: 'tool',
        round: ticks,
        name: tc.name,
        ok: toolResult.ok,
        args: tc.args,
        output: toolResult.output,
      });
      toolMsgs.push({
        role: 'tool',
        content: JSON.stringify(compressed),
        tool_call_id: tc.id,
      });
    }

    appendTranscript(workDir, {
      kind: 'assistant',
      round: ticks,
      content,
      tools: names,
    });
    messages = [...messages, assistantMsg, ...toolMsgs];
    logger.info('play', { event: 'tools', data: { round: ticks, tools: names } });
    process.stdout.write(`[play] round=${ticks} tools=${names.join(',')}\n`);
  }

  return finish({ ok: true, ticks, lastHadWork: true, stoppedBy: 'max_ticks', dist: PLAY_RUNTIME_LABEL });
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
