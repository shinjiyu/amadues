/**
 * AWAITING + ask_user pending → 单条 IM 通知（去重）。
 *
 * @see doc/structurizr/INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §3
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ChatIRChannel } from '@utlra/chat-ir';

import { listActivePendings } from '../openkuroneko/pendings/index.js';
import {
  fingerprintNotify,
  recordImNotifySent,
  shouldSendImNotify,
} from './im-notify-dedup.js';
import type { TaskRecord } from './inner-brain-registry.js';

export interface AwaitingNotifyDeps {
  imClient: ChatIRChannel;
  agentSid: string;
}

export async function notifyInnerBrainAwaitingHuman(
  deps: AwaitingNotifyDeps,
  record: Pick<TaskRecord, 'instanceId' | 'workDir' | 'originThread'>,
): Promise<boolean> {
  const threadId = record.originThread;
  if (!threadId) return false;

  const brainDir = path.join(record.workDir, '.brain');
  if (!fs.existsSync(path.join(brainDir, 'pendings.json'))) return false;

  const askUsers = listActivePendings(brainDir).filter((p) => p.kind === 'ask_user');
  const latest = askUsers.length > 0 ? askUsers[askUsers.length - 1] : null;
  if (!latest) return false;

  const prompt =
    typeof (latest.spec as { prompt?: unknown }).prompt === 'string'
      ? (latest.spec as { prompt: string }).prompt
      : '（无问题文本）';
  const normalized = prompt.trim().replace(/\s+/g, ' ');
  const fp = fingerprintNotify(record.instanceId, 'awaiting_human', normalized);

  if (!shouldSendImNotify(record.workDir, 'awaiting_human', fp)) {
    console.log(`[awaiting-notify] skip dedup (${record.instanceId}): ${fp}`);
    return false;
  }

  const text =
    `⏸ 内脑任务等待您的输入\n\n` +
    `**任务 ID**：\`${record.instanceId}\`\n` +
    `**问题**：${prompt}\n\n` +
    `请在本线程回复；回复后将自动继续执行。`;

  await deps.imClient.postMessage(threadId, {
    sender_sid: deps.agentSid,
    text,
  });
  recordImNotifySent(record.workDir, 'awaiting_human', fp);
  console.log(`[awaiting-notify] sent (${record.instanceId})`);
  return true;
}
