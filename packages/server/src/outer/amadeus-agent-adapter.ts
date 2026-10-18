/**
 * Amadeus as one remote teammate.
 * A host turn runs the existing outer-brain conversation and comes back as
 * say / presence / handoff. It does not post into WeChat or Feishu.
 *
 * @see doc/structurizr/AMADEUS-AGENT-ADAPTER.md
 */
import type { AgentTurn, AgentTurnResult, HostMessage, PresenceCard } from '@utlra/agent-host';

import type { TaskRecord, TaskStatus } from './inner-brain-registry.js';
import type { OuterHttpInboundParams, OuterHttpInboundResult } from './outer-http-inbound.js';

export function recordHostHandoff(
  rosterIds: readonly string[] | undefined,
  args: { toAgentId: string; note: string },
  sink: { handoff?: { toAgentId: string; note: string } } | undefined,
): string {
  const toAgentId = args.toAgentId.trim();
  const note = args.note.trim();
  if (!rosterIds?.includes(toAgentId)) return '这名队友不在这一轮的名单里。';
  if (!note) return '便条是空的。';
  if (sink) sink.handoff = { toAgentId, note };
  return '已记下交给这名队友的便条。';
}

export function hostThreadId(messageId: string): string {
  return `thread:dm:host:${messageId}`;
}

export function renderHostTurnText(turn: AgentTurn): string {
  const lines = ['其他队友：'];
  if (turn.roster.length === 0) {
    lines.push('（没有其他队友）');
  } else {
    for (const mate of turn.roster) {
      const card = turn.peers.find((peer) => peer.agentId === mate.id);
      const doing = card?.doing ? `，正在：${card.doing}` : '';
      lines.push(`- ${mate.name}（id=${mate.id}）岗位：${mate.job}${doing}`);
    }
  }
  lines.push('', '对方说：', turn.message.text);
  return lines.join('\n');
}

export function presenceForHostThread(
  tasks: Array<Pick<TaskRecord, 'originThread' | 'status' | 'goal' | 'startedAt'>>,
  threadId: string,
  humanId: string,
): { doing: string; waitingOn?: string } | undefined {
  const mine = tasks
    .filter((task) => task.originThread === threadId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const live = mine.find((task) => isOpen(task.status));
  if (!live) return undefined;
  const doing = live.goal.trim().split('\n')[0]?.trim() ?? '';
  if (!doing) return undefined;
  const waiting = live.status === 'AWAITING' || live.status === 'BLOCKED';
  return waiting ? { doing, waitingOn: humanId } : { doing };
}

function isOpen(status: TaskStatus): boolean {
  return status === 'RUNNING' || status === 'AWAITING' || status === 'BLOCKED';
}

function isHostMessage(value: unknown): value is HostMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as HostMessage;
  return (
    typeof message.id === 'string' &&
    message.id.trim() !== '' &&
    typeof message.text === 'string' &&
    !!message.from &&
    typeof message.from.id === 'string' &&
    !!message.to
  );
}

export function parseAcceptBody(body: unknown): AgentTurn {
  if (!body || typeof body !== 'object') throw new Error('bad accept: body');
  const raw = body as { message?: unknown; roster?: unknown; peers?: unknown };
  if (!isHostMessage(raw.message)) throw new Error('bad accept: message');
  if (!Array.isArray(raw.roster) || !Array.isArray(raw.peers)) throw new Error('bad accept: roster');
  return {
    message: raw.message,
    roster: raw.roster as AgentTurn['roster'],
    peers: raw.peers as PresenceCard[],
  };
}

export async function acceptAmadeusTurn(
  body: unknown,
  deps: {
    dispatch: (params: OuterHttpInboundParams) => Promise<OuterHttpInboundResult>;
    tasks: () => Array<Pick<TaskRecord, 'originThread' | 'status' | 'goal' | 'startedAt'>>;
  },
): Promise<AgentTurnResult> {
  const turn = parseAcceptBody(body);
  const threadId = hostThreadId(turn.message.id);
  const sink: NonNullable<OuterHttpInboundParams['hostHandoffSink']> = {};
  const result = await deps.dispatch({
    threadId,
    senderSid: turn.message.from.id,
    text: renderHostTurnText(turn),
    hostRosterIds: turn.roster.map((mate) => mate.id),
    hostHandoffSink: sink,
  });
  const say = result.replies
    .map((reply) => reply.text?.trim() ?? '')
    .filter((text) => text !== '')
    .join('\n');
  return {
    say: say === '' ? undefined : say,
    presence: presenceForHostThread(deps.tasks(), threadId, turn.message.from.id),
    handoff: sink.handoff,
  };
}
