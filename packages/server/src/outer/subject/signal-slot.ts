import {
  ADVISOR_SYSTEM,
  ENTITY_CAP,
  EVALUATE_TASK,
  GENERATE_TASK,
  NO_SIGNAL_LINE,
  SOURCE_CODE_POINTS,
} from './constants.js';
import { truncateCodePoints } from './text.js';
import type { SignalParse, SubjectSignal, SubjectState } from './types.js';

const SUSPICIOUS =
  /忽略之前|ignore\s+previous|you\s+must|删除记忆|disregard\s+(all\s+)?previous/i;

export function escapeObservation(raw: string): string {
  const closed = raw.replace(/<\/observation/gi, '〈/observation');
  return closed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function parseSignal(signal: Pick<SubjectSignal, 'source' | 'kind' | 'raw'>): SignalParse {
  const kind = signal.kind === 'status' ? 'message' : signal.kind === 'deferred' ? 'deferred' : signal.kind === 'event' ? 'event' : 'message';
  const raw = signal.raw ?? '';
  let intent: SignalParse['intent_category'] = 'statement';
  if (kind === 'event') intent = 'event';
  else if (SUSPICIOUS.test(raw)) intent = 'suspicious_instruction';
  else if (/[?？]|请|帮我|能不能|可以吗/.test(raw)) intent = 'request';

  let sentiment: SignalParse['sentiment'] = 'neutral';
  if (/谢谢|喜欢|太好了|不错/.test(raw)) sentiment = 'positive';
  else if (/讨厌|不行|别|不要/.test(raw)) sentiment = 'negative';

  const entities: string[] = [];
  const quoted = raw.match(/[「"']([^「"'」]{1,32})[」"']/g) ?? [];
  for (const hit of quoted) {
    const inner = hit.slice(1, -1).trim();
    if (inner && !entities.includes(inner)) entities.push(inner);
    if (entities.length >= ENTITY_CAP) break;
  }

  return {
    source: truncateCodePoints(signal.source, SOURCE_CODE_POINTS),
    kind,
    intent_category: intent,
    entities,
    sentiment,
  };
}

export function alignmentOf(parse: SignalParse, goals: SubjectState['goals']): 'high' | 'medium' | 'low' {
  if (parse.intent_category === 'suspicious_instruction') return 'low';
  const keywords = goals
    .filter((goal) => goal.priority >= 0.6)
    .flatMap((goal) => goal.keywords.map((word) => word.trim()).filter(Boolean));
  if (keywords.length > 0 && parse.entities.some((entity) => keywords.includes(entity))) return 'high';
  if (parse.intent_category === 'statement') return 'medium';
  return 'low';
}

export interface PromptHeader {
  identity: string;
  goals: SubjectState['goals'];
  drives: SubjectState['drives'];
  shortTerm: SubjectState['shortTerm'];
  deferredCount: number;
  soul: string;
}

function headerBlock(header: PromptHeader): string {
  const goals = header.goals.map((goal) => {
    const layer = goal.layer ?? 'mission';
    const link = goal.relatesTo?.length ? ` ${goal.relation ?? 'serves'}→${goal.relatesTo.join(',')}` : '';
    return `${goal.id}[${layer}${link}]:${goal.text}(${goal.priority})`;
  }).join(' | ') || '（无）';
  const drives = `curiosity=${header.drives.curiosity} social=${header.drives.social} completion=${header.drives.completion}`;
  const memory = header.shortTerm.map((row) => `${row.at} ${row.action} ${row.result}`).join(' | ') || '（无）';
  return [
    header.identity,
    `目标：${goals}`,
    `驱动力：${drives}`,
    `短期记忆：${memory}`,
    `延后条数：${header.deferredCount}`,
    header.soul ? `灵魂摘要：${header.soul}` : '灵魂摘要：（无）',
  ].join('\n');
}

export function observationBlock(signal: SubjectSignal, parse: SignalParse, alignment: 'high' | 'medium' | 'low'): string {
  const kind = signal.kind === 'status' ? 'status' : parse.kind;
  return [
    `解析字段：${JSON.stringify(parse)}；与我目标的契合度：${alignment}`,
    `<observation source="${escapeObservation(parse.source)}" kind="${kind}">${escapeObservation(signal.raw)}</observation>`,
  ].join('\n');
}

export function buildSubjectUserMessage(input: {
  header: PromptHeader;
  signals: Array<{ signal: SubjectSignal; parse: SignalParse; alignment: 'high' | 'medium' | 'low' }>;
  task: 'generate' | 'evaluate';
  candidatesJson?: string;
}): { system: string; user: string } {
  const slots = input.signals.length
    ? input.signals.map((row) => observationBlock(row.signal, row.parse, row.alignment)).join('\n')
    : NO_SIGNAL_LINE;
  const task = input.task === 'generate'
    ? GENERATE_TASK
    : `${EVALUATE_TASK}\n候选：${input.candidatesJson ?? '[]'}`;
  return {
    system: ADVISOR_SYSTEM,
    user: `${headerBlock(input.header)}\n${slots}\n${task}`,
  };
}
