/**
 * IM 人消息 → 同 thread 的 ask_user pending resolve（不 spawn，交给 changeWatcher）。
 *
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §5.2
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  listActivePendings,
  resolvePending,
  type PendingItem,
} from '../openkuroneko/pendings/index.js';
import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';
import type { ImInboundEvent } from './outer-brain.js';

export interface AwaitingInboundResolveResult {
  resolved: boolean;
  instanceId?: string;
  pendingId?: string;
  reason: string;
}

export function inboundMessageText(ev: ImInboundEvent): string {
  return ev.message.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n')
    .trim();
}

export function isHumanSender(senderSid: string): boolean {
  return !senderSid.startsWith('idp:agent:') && !senderSid.startsWith('agent:');
}

const DEFAULT_AGENT_MIRROR_SIDS = ['webchat:user:kuroneko'];

function agentMirrorSids(): Set<string> {
  const extra =
    process.env['UTLRA_AGENT_MIRROR_SIDS']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  return new Set([...DEFAULT_AGENT_MIRROR_SIDS, ...extra]);
}

/** 外脑/内脑 IM 通知模板 — 不得当人类回复 resolve pending */
export function isAgentNotificationEcho(text: string): boolean {
  const t = text.trim();
  if (/^✅/.test(t)) return true;
  if (/^⚠️\s*内脑任务被阻塞/.test(t)) return true;
  if (/^⏸\s*内脑任务等待您的输入/.test(t)) return true;
  return false;
}

export function isAgentMirrorSender(senderSid: string): boolean {
  const mirrors = agentMirrorSids();
  const base = senderSid.split('@')[0] ?? senderSid;
  return mirrors.has(senderSid) || mirrors.has(base);
}

function awaitingOnThread(registry: InnerBrainRegistry, threadId: string): TaskRecord[] {
  return registry
    .list()
    .filter(
      (t) =>
        (t.status === 'AWAITING' || t.status === 'BLOCKED') &&
        t.originThread === threadId,
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function pickTargetInstance(
  candidates: TaskRecord[],
  text: string,
): { target?: TaskRecord; reason?: string } {
  if (candidates.length === 0) {
    return { reason: 'no_awaiting_on_thread' };
  }
  if (candidates.length === 1) {
    return { target: candidates[0] };
  }
  const mentioned = candidates.find((t) => text.includes(t.instanceId));
  if (!mentioned) {
    return { reason: 'multiple_awaiting_disambiguation_required' };
  }
  return { target: mentioned };
}

function resolveLatestAskUser(workDir: string, replyText: string): PendingItem | null {
  const brainDir = path.join(workDir, '.brain');
  if (!fs.existsSync(path.join(brainDir, 'pendings.json'))) return null;

  const askUsers = listActivePendings(brainDir).filter((p) => p.kind === 'ask_user');
  const latest = askUsers.length > 0 ? askUsers[askUsers.length - 1] : null;
  if (!latest) return null;

  return resolvePending(brainDir, latest.id, { result: { reply: replyText } });
}

/**
 * 确定性 resolve：单 AWAITING 实例 + 最近 pending ask_user。
 * 仅写入 `{ reply: text }`；Memory Block / 凭证归档由外脑 LLM 另行 CRUD。
 */
export async function resolveAwaitingInboundFromIm(
  registry: InnerBrainRegistry,
  ev: ImInboundEvent,
): Promise<AwaitingInboundResolveResult> {
  if (!isHumanSender(ev.senderSid)) {
    return { resolved: false, reason: 'sender_not_human' };
  }

  if (isAgentMirrorSender(ev.senderSid)) {
    return { resolved: false, reason: 'sender_agent_mirror' };
  }

  const text = inboundMessageText(ev);
  if (isAgentNotificationEcho(text)) {
    return { resolved: false, reason: 'agent_notification_echo' };
  }

  if (/^\[NEW_GOAL\]/i.test(text)) {
    return { resolved: false, reason: 'new_goal_prefix' };
  }

  const { target, reason: pickReason } = pickTargetInstance(
    awaitingOnThread(registry, ev.threadId),
    text,
  );
  if (!target) {
    return { resolved: false, reason: pickReason ?? 'no_awaiting_on_thread' };
  }

  const resolved = resolveLatestAskUser(target.workDir, text);
  if (!resolved) {
    return {
      resolved: false,
      instanceId: target.instanceId,
      reason: 'no_pending_ask_user',
    };
  }

  return {
    resolved: true,
    instanceId: target.instanceId,
    pendingId: resolved.id,
    reason: 'ask_user_resolved',
  };
}
