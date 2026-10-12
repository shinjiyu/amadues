import type { ChatIRChannel } from '@utlra/chat-ir';

import {
  DECLINE_FALLBACK,
  INBOX_DRAIN,
  LEASE_MS,
  OBSERVATION_LOG_CODE_POINTS,
  RAW_CODE_POINTS,
  REPLY_CODE_POINTS,
  STATUS_THREAD_CAP,
} from './constants.js';
import { decayDrive, accrue, heartbeatShouldThink } from './drive.js';
import { decide, driveOf, ensureDoNothingAndDefer, parseCandidates, parseScores, readProposeSelfWork } from './decide.js';
import { alignmentOf, buildSubjectUserMessage, escapeObservation, parseSignal } from './signal-slot.js';
import { reactionFor, statusText } from './status-ack.js';
import {
  appendThinkLog,
  enqueueInbox,
  loadInbox,
  loadState,
  pushShortTerm,
  saveInbox,
  saveState,
} from './state-store.js';
import { truncateCodePoints } from './text.js';
import type {
  Candidate,
  DeferredItem,
  InboxItem,
  ScoreRow,
  SubjectSignal,
  SubjectState,
  ThinkLogRecord,
  ThinkTrigger,
} from './types.js';

export interface SubjectProposalDispatch {
  kind: 'kpi_advance' | 'ad_hoc';
  kpiId?: string;
  goalText: string;
  expectedOutcome: string;
  drive: 'curiosity' | 'completion';
}

export interface SubjectDispatchResult {
  dispatched: boolean;
  reason: string;
}

export interface RunSubjectThinkInput {
  dataRoot: string;
  nowMs?: number;
  trigger: ThinkTrigger;
  /** Humans waiting on this turn. Inbox drain is added inside. */
  signals?: SubjectSignal[];
  soul?: string;
  callLlm?: (system: string, user: string) => Promise<string>;
  imClient?: ChatIRChannel | null;
  agentSid: string;
  activeKpiIds?: string[];
  dispatchProposal?: (proposal: SubjectProposalDispatch) => Promise<SubjectDispatchResult>;
  /** Heartbeat: persist accrue even when the gate says not to think. */
  accrueOnly?: boolean;
  /** Returns true when a newer competing reply already took the thread. Speech is skipped. */
  freshCheck?: () => boolean | Promise<boolean>;
}

export interface RunSubjectThinkResult {
  action: string;
  thought: boolean;
  statusPosted: boolean;
  speechPosted: boolean;
  reason: string;
}

function newId(prefix: string, nowMs: number): string {
  return `${prefix}-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function humanMessages(signals: SubjectSignal[]): SubjectSignal[] {
  return signals.filter((signal) => signal.kind === 'message' && signal.threadId && !signal.historical);
}

function leaseActive(state: SubjectState, nowMs: number): boolean {
  if (!state.lease) return false;
  const until = Date.parse(state.lease.until);
  return Number.isFinite(until) && until > nowMs;
}

async function postStatus(input: {
  imClient?: ChatIRChannel | null;
  agentSid: string;
  threads: Array<{ threadId: string; messageId?: string; at?: string }>;
  text: string;
  reaction: 'seen' | 'later' | 'working';
}): Promise<{ posted: boolean; dropped: string[] }> {
  const seen = new Map<string, { threadId: string; messageId?: string; at?: string }>();
  for (const row of input.threads) {
    if (!row.threadId) continue;
    seen.set(row.threadId, row);
  }
  const ordered = [...seen.values()].sort((left, right) => (left.at ?? '').localeCompare(right.at ?? ''));
  const keep = ordered.slice(-STATUS_THREAD_CAP);
  const dropped = ordered.slice(0, Math.max(0, ordered.length - STATUS_THREAD_CAP)).map((row) => row.threadId);
  if (!input.imClient || keep.length === 0) return { posted: false, dropped };
  let posted = false;
  for (const row of keep) {
    try {
      await input.imClient.postMessage(row.threadId, {
        sender_sid: input.agentSid,
        text: input.text,
        parse_mentions: false,
        disposition: 'status',
      });
      posted = true;
      const react = input.imClient.addStatusReaction;
      if (react && row.messageId) {
        try {
          await react.call(input.imClient, row.threadId, row.messageId, input.reaction);
        } catch (error) {
          console.log(`[utlra][subject] reaction skipped ${error instanceof Error ? error.message : error}`);
        }
      }
    } catch (error) {
      console.log(`[utlra][subject] status post failed ${error instanceof Error ? error.message : error}`);
    }
  }
  return { posted, dropped };
}

function logObservation(signal: SubjectSignal, parse: ReturnType<typeof parseSignal>, alignment: string) {
  return {
    source: parse.source,
    kind: signal.kind,
    alignment,
    observation: truncateCodePoints(escapeObservation(signal.raw), OBSERVATION_LOG_CODE_POINTS),
    intent: parse.intent_category,
  };
}

function replyText(candidate: Candidate): string {
  const text = candidate.args.text;
  return typeof text === 'string' ? truncateCodePoints(text.trim(), REPLY_CODE_POINTS) : '';
}

export async function runSubjectThink(input: RunSubjectThinkInput): Promise<RunSubjectThinkResult> {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const loaded = loadState(input.dataRoot, nowMs);
  const inboundSignals = input.signals ?? [];
  const inboxAll = loadInbox(input.dataRoot);

  if (leaseActive(loaded, nowMs)) {
    for (const signal of inboundSignals) {
      if (signal.kind !== 'message' || signal.historical) continue;
      const exists = inboxAll.some((item) => item.messageId && item.messageId === signal.messageId);
      if (!exists) {
        enqueueInbox(input.dataRoot, {
          id: newId('in', nowMs),
          source: signal.source,
          kind: 'message',
          threadId: signal.threadId ?? null,
          raw: signal.raw,
          at: signal.at ?? nowIso,
          messageId: signal.messageId,
        });
      }
    }
    const humans = humanMessages(inboundSignals);
    let statusPosted = false;
    if (humans.length > 0) {
      const text = statusText({ action: 'lease_held', deferRevisitMs: loaded.deferRevisitMs });
      const posted = await postStatus({
        imClient: input.imClient,
        agentSid: input.agentSid,
        threads: humans.map((signal) => ({
          threadId: signal.threadId ?? '',
          messageId: signal.messageId,
          at: signal.at,
        })),
        text,
        reaction: 'later',
      });
      statusPosted = posted.posted;
    }
    return { action: 'lease_held', thought: false, statusPosted, speechPosted: false, reason: 'lease_held' };
  }

  let state = accrue(loaded, nowMs);
  const drivesBefore = { ...state.drives };
  const due = state.deferred.filter((item) => item.status === 'open' && Date.parse(item.revisitAt) <= nowMs);
  if (input.trigger === 'heartbeat_tail' && input.accrueOnly) {
    saveState(input.dataRoot, state);
    return { action: 'wait', thought: false, statusPosted: false, speechPosted: false, reason: '驱动力未过阈值且无信号' };
  }
  if (input.trigger === 'heartbeat_tail') {
    const should = heartbeatShouldThink({
      state,
      nowMs,
      dueDefer: due.length > 0,
      inboxNonEmpty: inboxAll.length > 0,
    });
    if (!should) {
      saveState(input.dataRoot, state);
      return { action: 'wait', thought: false, statusPosted: false, speechPosted: false, reason: '驱动力未过阈值且无信号' };
    }
  }

  const drained = inboxAll.slice(0, INBOX_DRAIN);
  const inboxLeft = inboxAll.slice(INBOX_DRAIN);
  const inboxSignals: SubjectSignal[] = drained.map((item) => ({
    source: item.source,
    kind: item.kind,
    raw: item.raw,
    threadId: item.threadId,
    at: item.at,
    messageId: item.messageId,
  }));
  const dueSignals: SubjectSignal[] = due.map((item) => ({
    source: `deferred:${item.id}`,
    kind: 'deferred',
    raw: item.raw,
    threadId: item.threadId,
    at: item.createdAt,
  }));
  const signals = [...dueSignals, ...inboxSignals, ...inboundSignals];
  if (input.trigger === 'inbound' && signals.length === 0) {
    saveState(input.dataRoot, state);
    return { action: 'wait', thought: false, statusPosted: false, speechPosted: false, reason: '无信号' };
  }

  state = {
    ...state,
    lease: { owner: 'subject-think', until: new Date(nowMs + LEASE_MS).toISOString() },
  };
  saveState(input.dataRoot, state);
  saveInbox(input.dataRoot, inboxLeft);

  const prepared = signals.map((signal) => {
    const parse = parseSignal(signal);
    return { signal, parse, alignment: alignmentOf(parse, state.goals) };
  });
  const header = {
    identity: state.identity,
    goals: state.goals,
    drives: state.drives,
    shortTerm: state.shortTerm,
    deferredCount: state.deferred.filter((item) => item.status === 'open').length,
    soul: truncateCodePoints(input.soul ?? '', 500),
  };

  let candidates: Candidate[] = [];
  let scores: ScoreRow[] = [];
  const call = input.callLlm;
  if (call) {
    const generated = buildSubjectUserMessage({ header, signals: prepared, task: 'generate' });
    let genText = '';
    try {
      genText = await call(generated.system, generated.user);
    } catch (error) {
      console.log(`[utlra][subject] generate failed ${error instanceof Error ? error.message : error}`);
    }
    candidates = ensureDoNothingAndDefer(parseCandidates(genText));
    const evaluated = buildSubjectUserMessage({
      header,
      signals: prepared,
      task: 'evaluate',
      candidatesJson: JSON.stringify(candidates.map((row) => ({ action: row.action, args: row.args }))),
    });
    let evalText = '';
    try {
      evalText = await call(evaluated.system, evaluated.user);
    } catch (error) {
      console.log(`[utlra][subject] evaluate failed ${error instanceof Error ? error.message : error}`);
    }
    scores = parseScores(evalText, candidates.map((row) => row.action));
  } else {
    candidates = ensureDoNothingAndDefer([]);
    scores = candidates.map((row) => ({ action: row.action, score: 0 }));
  }

  let pool = candidates;
  let decision = decide({ candidates: pool, scores, drives: state.drives, driveWeight: state.driveWeight });
  const active = new Set(input.activeKpiIds ?? []);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const chosen = decision.chosen;
    if (!chosen) break;
    if (chosen.action === 'reply_to_thread' && !replyText(chosen)) {
      decision.rejected.push({ action: 'reply_to_thread', why: '空文本' });
      pool = pool.filter((row) => row !== chosen);
      decision = decide({ candidates: pool, scores, drives: state.drives, driveWeight: state.driveWeight });
      continue;
    }
    if (chosen.action === 'propose_self_work') {
      const ready = readProposeSelfWork(chosen.args);
      const kpiId = ready.ok ? ready.proposal.kpiId ?? '' : '';
      if (!ready.ok) {
        decision.rejected.push({ action: 'propose_self_work', why: ready.why });
        pool = pool.filter((row) => row !== chosen);
        decision = decide({ candidates: pool, scores, drives: state.drives, driveWeight: state.driveWeight });
        continue;
      }
      if (ready.proposal.kind === 'kpi_advance' && !active.has(kpiId)) {
        decision.rejected.push({ action: 'propose_self_work', why: '无 active KPI' });
        pool = pool.filter((row) => row !== chosen);
        decision = decide({ candidates: pool, scores, drives: state.drives, driveWeight: state.driveWeight });
        continue;
      }
      chosen.args = { ...chosen.args, ...ready.proposal };
    }
    if (chosen.action === 'schedule_revisit') {
      const deferredId = typeof chosen.args.deferredId === 'string' ? chosen.args.deferredId : '';
      const open = state.deferred.some((item) => item.status === 'open' && item.id === deferredId);
      if (!open) {
        decision.rejected.push({ action: 'schedule_revisit', why: '无对应延后项' });
        pool = pool.filter((row) => row !== chosen);
        decision = decide({ candidates: pool, scores, drives: state.drives, driveWeight: state.driveWeight });
        continue;
      }
    }
    break;
  }

  const chosen = decision.chosen ?? { action: 'do_nothing', args: {} };
  let result = chosen.action;
  let proposalDispatched = false;
  let speechPosted = false;
  const touchedDueIds = new Set(due.map((item) => item.id));

  if (chosen.action === 'defer') {
    const fresh: DeferredItem[] = [];
    for (const row of prepared) {
      if (row.signal.kind !== 'message' || row.signal.historical) continue;
      fresh.push({
        id: newId('def', nowMs),
        source: row.parse.source,
        kind: 'message',
        threadId: row.signal.threadId ?? null,
        raw: truncateCodePoints(row.signal.raw, RAW_CODE_POINTS),
        parsed: row.parse,
        createdAt: nowIso,
        revisitAt: new Date(nowMs + state.deferRevisitMs).toISOString(),
        statusAckAt: null,
        status: 'open',
      });
    }
    let deferred = state.deferred.map((item) => {
      if (!touchedDueIds.has(item.id)) return item;
      return {
        ...item,
        status: 'open' as const,
        revisitAt: new Date(nowMs + state.deferRevisitMs).toISOString(),
      };
    });
    deferred = [...deferred, ...fresh];
    const open = deferred.filter((item) => item.status === 'open');
    if (open.length > state.deferredCap) {
      const overflow = open.length - state.deferredCap;
      const dropIds = new Set(
        [...open]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
          .slice(0, overflow)
          .map((item) => item.id),
      );
      deferred = deferred.map((item) => dropIds.has(item.id) ? { ...item, status: 'dropped' as const } : item);
    }
    state = { ...state, deferred };
    state = pushShortTerm(state, { at: nowIso, action: 'defer', result: 'open' });
  } else if (chosen.action === 'schedule_revisit') {
    const id = typeof chosen.args.deferredId === 'string' ? chosen.args.deferredId : '';
    const revisitAt = typeof chosen.args.revisitAt === 'string' ? chosen.args.revisitAt : nowIso;
    state = {
      ...state,
      deferred: state.deferred.map((item) => {
        if (item.id === id && item.status === 'open') return { ...item, revisitAt };
        if (touchedDueIds.has(item.id) && item.status === 'open') return { ...item, status: 'revisited' as const };
        return item;
      }),
    };
    state = decayDrive(state, 'completion');
    state = pushShortTerm(state, { at: nowIso, action: 'schedule_revisit', result: id });
  } else if (chosen.action === 'reply_to_thread' || chosen.action === 'decline') {
    const text = chosen.action === 'decline' && !replyText(chosen)
      ? DECLINE_FALLBACK
      : replyText(chosen);
    let stale = false;
    if (input.freshCheck) {
      try {
        stale = Boolean(await input.freshCheck());
      } catch {
        stale = false;
      }
    }
    if (input.imClient && text && !stale) {
      const threadId = humanMessages([...inboundSignals, ...inboxSignals])[0]?.threadId
        ?? due.find((item) => item.threadId)?.threadId
        ?? '';
      if (threadId) {
        await input.imClient.postMessage(threadId, { sender_sid: input.agentSid, text, disposition: 'speech' });
        speechPosted = true;
      }
    }
    state = decayDrive(state, 'social');
    state = pushShortTerm(state, { at: nowIso, action: chosen.action, result: text });
    result = text;
  } else if (chosen.action === 'propose_self_work') {
    const ready = readProposeSelfWork(chosen.args);
    let dispatched: SubjectDispatchResult = { dispatched: false, reason: ready.ok ? 'no_dispatcher' : ready.why };
    if (ready.ok && input.dispatchProposal) {
      const proposal = {
        ...ready.proposal,
        goalText: truncateCodePoints(ready.proposal.goalText, 500),
      };
      try {
        dispatched = await input.dispatchProposal(proposal);
      } catch (error) {
        dispatched = { dispatched: false, reason: error instanceof Error ? error.message : 'dispatch_failed' };
      }
    }
    proposalDispatched = dispatched.dispatched;
    result = dispatched.reason;
    if (ready.ok && proposalDispatched) state = decayDrive(state, ready.proposal.drive);
    else if (ready.ok) {
      state = {
        ...state,
        deferred: [...state.deferred, {
          id: newId('def', nowMs),
          source: 'subject',
          kind: 'event',
          threadId: humanMessages(signals)[0]?.threadId ?? null,
          raw: truncateCodePoints('未派出的自发工作', RAW_CODE_POINTS),
          parsed: parseSignal({ source: 'subject', kind: 'event', raw: '未派出的自发工作' }),
          createdAt: nowIso,
          revisitAt: new Date(nowMs + state.deferRevisitMs).toISOString(),
          statusAckAt: null,
          status: 'open',
        }],
      };
    }
    state = pushShortTerm(state, { at: nowIso, action: 'propose_self_work', result: dispatched.reason });
  } else {
    if (touchedDueIds.size > 0 && chosen.action !== 'defer') {
      state = {
        ...state,
        deferred: state.deferred.map((item) => touchedDueIds.has(item.id) ? { ...item, status: 'revisited' } : item),
      };
    }
    state = pushShortTerm(state, { at: nowIso, action: chosen.action, result: 'no-side-effect' });
  }

  if (chosen.action !== 'defer' && touchedDueIds.size > 0 && chosen.action !== 'schedule_revisit') {
    state = {
      ...state,
      deferred: state.deferred.map((item) => touchedDueIds.has(item.id) && item.status === 'open'
        ? { ...item, status: 'revisited' }
        : item),
    };
  }

  const humans = humanMessages(signals);
  const nonChat = new Set(['no_reply', 'defer', 'wait', 'do_nothing', 'schedule_revisit', 'propose_self_work']);
  const alreadyAcked = humans.length > 0 && humans.every((signal) => {
    if (signal.kind !== 'message') return true;
    const prior = state.deferred.find((item) => item.raw === signal.raw && item.statusAckAt);
    return Boolean(prior);
  }) && chosen.action === 'defer' && inboundSignals.length === 0;
  let statusPosted = false;
  let statusDroppedThreads: string[] | undefined;
  if (humans.length > 0 && nonChat.has(chosen.action) && !alreadyAcked) {
    const revisitAt = typeof chosen.args.revisitAt === 'string' ? chosen.args.revisitAt : undefined;
    const text = statusText({
      action: chosen.action,
      deferRevisitMs: state.deferRevisitMs,
      revisitAt,
      proposalDispatched,
    });
    const posted = await postStatus({
      imClient: input.imClient,
      agentSid: input.agentSid,
      threads: humans.map((signal) => ({
        threadId: signal.threadId ?? '',
        messageId: signal.messageId,
        at: signal.at,
      })),
      text,
      reaction: reactionFor(chosen.action, proposalDispatched),
    });
    statusPosted = posted.posted;
    if (posted.dropped.length) statusDroppedThreads = posted.dropped;
    if (statusPosted && chosen.action === 'defer') {
      const ackedThreads = new Set(humans.map((signal) => signal.threadId));
      state = {
        ...state,
        deferred: state.deferred.map((item) => ackedThreads.has(item.threadId) && !item.statusAckAt
          ? { ...item, statusAckAt: nowIso }
          : item),
      };
    }
  }

  if (input.trigger === 'heartbeat_tail') {
    state = { ...state, lastDriveOnlyThinkAt: nowIso };
  }
  state = { ...state, lease: null };
  saveState(input.dataRoot, state);

  const selfInitiated = !signals.some((signal) => signal.kind === 'message')
    && !['wait', 'do_nothing', 'defer', 'no_reply'].includes(chosen.action);
  const record: ThinkLogRecord = {
    at: nowIso,
    trigger: input.trigger,
    drivesBefore,
    drivesAfter: state.drives,
    signals: prepared.map((row) => logObservation(row.signal, row.parse, row.alignment)),
    candidates,
    scores,
    rejected: decision.rejected,
    chosen: chosen.action,
    reason: decision.reason,
    selfInitiated,
    result: String(result),
    statusPosted,
    statusDroppedThreads,
  };
  appendThinkLog(input.dataRoot, record);
  return { action: chosen.action, thought: true, statusPosted, speechPosted, reason: decision.reason };
}

export function subjectHeartbeatWouldThink(dataRoot: string, nowMs = Date.now()): boolean {
  const state = accrue(loadState(dataRoot, nowMs), nowMs);
  const due = state.deferred.some((item) => item.status === 'open' && Date.parse(item.revisitAt) <= nowMs);
  return heartbeatShouldThink({
    state,
    nowMs,
    dueDefer: due,
    inboxNonEmpty: loadInbox(dataRoot).length > 0,
  });
}

export function rememberInbound(dataRoot: string, item: InboxItem): void {
  enqueueInbox(dataRoot, { ...item, raw: truncateCodePoints(item.raw, RAW_CODE_POINTS) });
}

export { driveOf };
