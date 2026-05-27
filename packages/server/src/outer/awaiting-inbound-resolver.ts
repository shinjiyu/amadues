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
import type { MemoryBlockStore } from './memory-block-store.js';
import {
  looksLikeCredential,
  vaultCredentialReply,
  type CredentialRefResult,
} from './credential-ref.js';

export interface AwaitingInboundResolveOptions {
  memoryBlockStore?: MemoryBlockStore;
  /** 写入 keychain 时的 updated_by（默认 human sender） */
  updatedBy?: string;
}

export interface AwaitingInboundResolveResult {
  resolved: boolean;
  instanceId?: string;
  pendingId?: string;
  reason: string;
  /** B2：凭证已 vault + bind，pending result 为 credential_ref */
  credentialRef?: CredentialRefResult;
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

async function resolveLatestAskUser(
  workDir: string,
  replyText: string,
  opts?: AwaitingInboundResolveOptions & { askPrompt?: string },
): Promise<PendingItem | null> {
  const brainDir = path.join(workDir, '.brain');
  if (!fs.existsSync(path.join(brainDir, 'pendings.json'))) return null;

  const askUsers = listActivePendings(brainDir).filter((p) => p.kind === 'ask_user');
  const latest = askUsers.length > 0 ? askUsers[askUsers.length - 1] : null;
  if (!latest) return null;

  const askPrompt =
    opts?.askPrompt ??
    (typeof latest.spec === 'object' && latest.spec && 'prompt' in latest.spec
      ? String((latest.spec as { prompt?: string }).prompt ?? '')
      : '');

  let result: unknown = { reply: replyText };
  if (opts?.memoryBlockStore && looksLikeCredential(replyText)) {
    result = await vaultCredentialReply(
      opts.memoryBlockStore,
      workDir,
      replyText,
      askPrompt,
      opts.updatedBy ?? 'human:im',
    );
  }

  return resolvePending(brainDir, latest.id, { result });
}

/**
 * 确定性 resolve：单 AWAITING 实例 + 最近 pending ask_user。
 */
export async function resolveAwaitingInboundFromIm(
  registry: InnerBrainRegistry,
  ev: ImInboundEvent,
  opts?: AwaitingInboundResolveOptions,
): Promise<AwaitingInboundResolveResult> {
  if (!isHumanSender(ev.senderSid)) {
    return { resolved: false, reason: 'sender_not_human' };
  }

  const text = inboundMessageText(ev);
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

  const resolved = await resolveLatestAskUser(target.workDir, text, {
    memoryBlockStore: opts?.memoryBlockStore,
    updatedBy: opts?.updatedBy ?? ev.senderSid,
  });
  if (!resolved) {
    return {
      resolved: false,
      instanceId: target.instanceId,
      reason: 'no_pending_ask_user',
    };
  }

  const cred =
    resolved.result &&
    typeof resolved.result === 'object' &&
    (resolved.result as CredentialRefResult).kind === 'credential_ref'
      ? (resolved.result as CredentialRefResult)
      : undefined;

  return {
    resolved: true,
    instanceId: target.instanceId,
    pendingId: resolved.id,
    reason: cred ? 'ask_user_resolved_credential_ref' : 'ask_user_resolved',
    ...(cred ? { credentialRef: cred } : {}),
  };
}
