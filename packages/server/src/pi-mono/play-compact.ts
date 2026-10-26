/**
 * 玩耍循环的上下文压缩。
 *
 * 对话变长时，把更早的轮次收成一条备忘，最近几轮保持原文。
 * 备忘写入 .brain/play-context.md，下次进程拉起时读回来。
 * 只记已经发生的事，不派下一步。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { LLMAdapter, Message } from '../openkuroneko/adapter/index.js';

export const PLAY_SUMMARY_MARK = '此前身体经历的备忘，不是新指令：';

export const PLAY_COMPACT_SYSTEM =
  '把下面的身体对话压成备忘。只保留已经发生的事：看过的画面、手臂到过的姿态、说过的话、屏上的字、写下的文件、记过的事实。不要派下一步，不要评价。中文，短。';

const CONTEXT_FILE = path.join('.brain', 'play-context.md');

export function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.map(block => (block.type === 'text' ? block.text : '')).join('');
}

export function contextChars(messages: Message[]): number {
  let n = 0;
  for (const message of messages) {
    n += messageText(message.content).length;
    if (message.tool_calls) n += JSON.stringify(message.tool_calls).length;
  }
  return n;
}

export function compactCharThreshold(): number {
  const n = Number(process.env['PLAY_COMPACT_CHARS'] ?? 120_000);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export function compactKeepRounds(): number {
  const n = Number(process.env['PLAY_COMPACT_KEEP_ROUNDS'] ?? 6);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
}

export interface PlayCompactSplit {
  opening: Message;
  prior: string;
  dropped: Message[];
  recent: Message[];
}

/** 轮次不超过 keepRounds 时不压缩。keepRounds 为 0 表示全部收进备忘。 */
export function splitPlayMessages(messages: Message[], keepRounds: number): PlayCompactSplit | null {
  const opening = messages[0];
  if (!opening || opening.role !== 'user') return null;

  let index = 1;
  let prior = '';
  const second = messages[1];
  if (second?.role === 'user' && messageText(second.content).startsWith(PLAY_SUMMARY_MARK)) {
    prior = messageText(second.content).slice(PLAY_SUMMARY_MARK.length).trim();
    index = 2;
  }

  const rounds: Message[][] = [];
  while (index < messages.length) {
    const assistant = messages[index];
    if (!assistant || assistant.role !== 'assistant') break;
    const block: Message[] = [assistant];
    index += 1;
    while (index < messages.length && messages[index]?.role === 'tool') {
      block.push(messages[index]!);
      index += 1;
    }
    rounds.push(block);
  }
  if (rounds.length <= keepRounds) return null;

  const dropped = rounds.slice(0, rounds.length - keepRounds).flat();
  const recent = rounds.slice(rounds.length - keepRounds).flat();
  return { opening, prior, dropped, recent };
}

export function renderCompactSource(prior: string, dropped: Message[]): string {
  const lines: string[] = [];
  if (prior.trim()) lines.push(prior.trim());
  for (const message of dropped) {
    if (message.role === 'assistant') {
      const text = messageText(message.content).trim();
      const tools = (message.tool_calls ?? []).map(call => call.function.name).join(',');
      if (tools) lines.push(`助手 调用 ${tools}${text ? ` ${text.slice(0, 200)}` : ''}`);
      else if (text) lines.push(`助手 ${text.slice(0, 400)}`);
    } else if (message.role === 'tool') {
      const body = messageText(message.content).replace(/\s+/g, ' ').slice(0, 400);
      if (body) lines.push(`工具结果 ${body}`);
    }
  }
  return lines.join('\n').slice(0, 24_000);
}

export function summaryMessage(summary: string): Message {
  return { role: 'user', content: `${PLAY_SUMMARY_MARK}\n${summary.trim()}` };
}

export function assemblePlayMessages(opening: Message, summary: string, recent: Message[]): Message[] {
  const out: Message[] = [opening];
  if (summary.trim()) out.push(summaryMessage(summary));
  out.push(...recent);
  return out;
}

export function readPlayContext(workDir: string): string {
  try {
    return fs.readFileSync(path.join(workDir, CONTEXT_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

export function writePlayContext(workDir: string, summary: string): void {
  const file = path.join(workDir, CONTEXT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${summary.trim()}\n`, 'utf8');
}

export interface PlayLogRow {
  kind?: string;
  name?: string;
  content?: string;
  output?: string;
  args?: Record<string, unknown>;
  tools?: string[];
}

function formatToolRow(row: PlayLogRow): string {
  const name = row.name ?? 'tool';
  const args = row.args ?? {};
  if (name === 'mouth_say') return `嘴 「${String(args['text'] ?? '')}」`;
  if (name === 'screen_show') {
    return `屏 ${String(args['title'] ?? '')} ${String(args['body'] ?? '').slice(0, 200)}`;
  }
  if (name === 'eye_look') {
    let desc = '';
    try {
      desc = String(JSON.parse(row.output ?? '').description ?? '');
    } catch {
      desc = '';
    }
    return `眼 ${desc.replace(/\s+/g, ' ').slice(0, 300) || '无描述'}`;
  }
  if (name === 'arm_feedback' || name === 'arm_stream') {
    let pose = '';
    try {
      const parsed = JSON.parse(row.output ?? '') as { q?: unknown; commanded?: unknown };
      pose = JSON.stringify(parsed.q ?? parsed.commanded ?? '');
    } catch {
      pose = '';
    }
    return `${name} ${pose}`;
  }
  if (name === 'record_fact') return `记事实 ${String(args['fact'] ?? '')}`;
  return `${name} ${(row.output ?? '').replace(/\s+/g, ' ').slice(0, 180)}`;
}

/** 用 play.jsonl 里的全文做压缩材料。省略 compact 行，并可留下最近几轮不收进备忘。 */
export function sourceFromPlayLog(rows: PlayLogRow[], omitRecentRounds = 0): string {
  let start = 0;
  rows.forEach((row, index) => {
    if (row.kind === 'compact') start = index + 1;
  });
  const rounds: string[][] = [];
  let current: string[] | null = null;
  for (const row of rows.slice(start)) {
    if (row.kind === 'tool') {
      current ??= [];
      current.push(formatToolRow(row));
    } else if (row.kind === 'assistant') {
      current ??= [];
      const tools = (row.tools ?? []).join(',');
      const text = (row.content ?? '').trim();
      if (tools) current.push(`助手 调用 ${tools}${text ? ` ${text.slice(0, 200)}` : ''}`);
      else if (text) current.push(`助手 ${text.slice(0, 400)}`);
      if (current.length) rounds.push(current);
      current = null;
    }
  }
  if (current?.length) rounds.push(current);
  const kept = omitRecentRounds > 0 ? rounds.slice(0, Math.max(0, rounds.length - omitRecentRounds)) : rounds;
  return kept.flat().join('\n').slice(-24_000);
}

export async function summarizePlaySource(llm: LLMAdapter, source: string): Promise<string | null> {
  const text = source.trim().slice(-24_000);
  if (!text) return null;
  const result = await llm.chat(PLAY_COMPACT_SYSTEM, [{ role: 'user', content: text }]);
  return (result.content ?? '').trim() || null;
}

export async function summarizePlayDialogue(
  llm: LLMAdapter,
  prior: string,
  dropped: Message[],
): Promise<string | null> {
  return summarizePlaySource(llm, renderCompactSource(prior, dropped));
}
