/**
 * baseNode ReAct messages 轻量 prune — 保护首条 user + 最近 N 轮，旧轮 tool 输出替换为占位；
 * 旧轮 assistant 的 write_file/edit_file 参数瘦身（P2.5）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.5
 */

import type { Message } from '../adapter/index.js';
import { isToolArgsSlimEnabled } from '../tools/write-content-guard.js';
import { slimAssistantMessageToolCalls } from './react-tool-call-slim.js';

export interface ReactPruneOptions {
  /** 保留完整内容的最近 ReAct 轮数（含 assistant+tools） */
  protectRecentRounds?: number;
  /** 为 false 时原样返回（INNER_REACT_PRUNE=0） */
  enabled?: boolean;
}

type RoundBlock = { assistant: Message; tools: Message[] };

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isPruneEnabled(explicit?: boolean): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  const raw = process.env['INNER_REACT_PRUNE']?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

function splitIntoRounds(messages: Message[]): { head: Message[]; rounds: RoundBlock[] } {
  const head: Message[] = [];
  let i = 0;
  if (messages[0]?.role === 'user') {
    head.push(messages[0]);
    i = 1;
  }
  const rounds: RoundBlock[] = [];
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === 'assistant') {
      const assistant = m;
      i += 1;
      const tools: Message[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') {
        tools.push(messages[i]!);
        i += 1;
      }
      rounds.push({ assistant, tools });
    } else {
      head.push(m);
      i += 1;
    }
  }
  return { head, rounds };
}

function pruneToolMessage(msg: Message): Message {
  const raw = typeof msg.content === 'string' ? msg.content : '';
  let hint = 'tool output removed from context to save tokens';
  try {
    const j = JSON.parse(raw) as { ok?: boolean; output?: string };
    if (typeof j.output === 'string') {
      const spill = j.output.match(/\[全文 \d+ 字符已写入 ([^\]]+)\]/);
      if (spill?.[1]) {
        hint = `pruned; full output at ${spill[1]} (read_file)`;
      } else {
        hint = `pruned; was ${j.output.length} chars (see inner tool-audit if needed)`;
      }
    }
    return {
      ...msg,
      content: JSON.stringify({ ok: j.ok ?? false, output: `[react-prune] ${hint}` }),
    };
  } catch {
    return { ...msg, content: `[react-prune] ${hint}` };
  }
}

/**
 * 旧轮：assistant 的 write_file/edit_file 参数瘦身 + tool 结果占位。
 */
export function pruneReActMessages(messages: Message[], opts: ReactPruneOptions = {}): Message[] {
  if (!isPruneEnabled(opts.enabled)) return messages;

  const protectRounds = opts.protectRecentRounds ?? readPositiveIntEnv('INNER_REACT_PRUNE_PROTECT_ROUNDS', 2);
  const { head, rounds } = splitIntoRounds(messages);
  if (rounds.length <= protectRounds) {
    return [...head, ...rounds.flatMap((b) => [b.assistant, ...b.tools])];
  }

  const keepFrom = rounds.length - protectRounds;
  const out: Message[] = [...head];
  for (let r = 0; r < rounds.length; r++) {
    const block = rounds[r]!;
    const assistant =
      r < keepFrom && isToolArgsSlimEnabled()
        ? slimAssistantMessageToolCalls(block.assistant)
        : block.assistant;
    out.push(assistant);
    if (r < keepFrom) {
      for (const t of block.tools) out.push(pruneToolMessage(t));
    } else {
      out.push(...block.tools);
    }
  }
  return out;
}
