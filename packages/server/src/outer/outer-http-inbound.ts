/**
 * HTTP 离线调试：触发与 IM 相同的 OuterBrain.handleInbound 路径。
 * 出站消息经 FakeImChannel 捕获并随响应返回（不经真实 Chat IR channel）。
 */
import { randomUUID } from 'node:crypto';

import {
  ensureThreadShell,
  MessagePartSchema,
  MessageRecordSchema,
  ThreadRecordSchema,
  type ChatIRChannel,
  type ChatIROutboundBody,
  type LooseThreadStore,
  type MessagePart,
} from '@utlra/chat-ir';
import { OuterBrain, type OuterBrainDeps } from './outer-brain.js';

class CaptureImChannel implements ChatIRChannel {
  readonly outbox: Array<{ threadId: string; body: ChatIROutboundBody; at: string }> = [];

  start(): void {}
  destroy(): void {}

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    this.outbox.push({ threadId, body, at: new Date().toISOString() });
  }
}

export interface OuterHttpInboundParams {
  threadId: string;
  senderSid: string;
  /** 与 `messageParts` 二选一（或同时给：以 `messageParts` 为准） */
  text?: string;
  messageParts?: MessagePart[];
  /** IM 已写入本条时可 true，与 text/parts 二选一 */
  userMessagePersisted?: boolean;
  participantSids?: string[];
}

export interface OuterHttpOutboundReply {
  threadId: string;
  senderSid: string;
  text?: string;
  parts?: unknown[];
  sentAt: string;
}

export interface OuterHttpInboundResult {
  threadId: string;
  messageId: string;
  replies: OuterHttpOutboundReply[];
}

export interface OuterHttpThreadStore {
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
}

function resolveInboundParts(params: OuterHttpInboundParams): MessagePart[] {
  if (params.messageParts?.length) {
    return params.messageParts.map((part) => MessagePartSchema.parse(part));
  }
  if (params.text?.trim()) {
    return [{ type: 'text', text: params.text.trim() }];
  }
  throw new Error('text or messageParts required');
}

function resolvePersistedParts(
  threadStore: OuterHttpThreadStore,
  threadId: string,
  senderSid: string,
): MessagePart[] {
  const data = threadStore.loadThreads();
  const rawList = data.messages[threadId] ?? [];
  if (rawList.length === 0) {
    throw new Error('user_message_persisted: thread has no messages');
  }
  const lastParsed = MessageRecordSchema.parse(rawList[rawList.length - 1]!);
  if (lastParsed.sender_sid !== senderSid) {
    throw new Error(
      `user_message_persisted: last message sender ${lastParsed.sender_sid} !== ${senderSid}`,
    );
  }
  return lastParsed.parts.map((part) => MessagePartSchema.parse(part));
}

function inferThreadKind(threadId: string): 'dm' | 'group' {
  if (threadId.includes('group') || threadId.endsWith(':global')) return 'group';
  if (threadId.includes(':dm:') || threadId.startsWith('thread:dm:')) return 'dm';
  return 'group';
}

function persistUserMessage(
  threadStore: OuterHttpThreadStore,
  threadId: string,
  senderSid: string,
  parts: MessagePart[],
): string {
  const data = threadStore.loadThreads();
  ensureThreadShell(data, threadId, [senderSid]);
  const kind = inferThreadKind(threadId);
  for (let i = 0; i < data.threads.length; i++) {
    const parsed = ThreadRecordSchema.safeParse(data.threads[i]);
    if (parsed.success && parsed.data.thread_id === threadId) {
      data.threads[i] = { ...parsed.data, kind };
      break;
    }
  }
  const messageId = `msg:${randomUUID()}`;
  const userMsg = MessageRecordSchema.parse({
    schema: 'message.v1',
    message_id: messageId,
    thread_id: threadId,
    sender_sid: senderSid,
    sent_at: new Date().toISOString(),
    parts,
  });
  const list = data.messages[threadId] ?? [];
  list.push(userMsg);
  data.messages[threadId] = list;
  threadStore.saveThreads(data);
  return messageId;
}

/** 与 IM 主路径一致：经 ThreadOrchestrator → 外脑对话环；出站写入 FakeIm outbox。 */
export async function dispatchOuterHttpInbound(
  deps: OuterBrainDeps,
  threadStore: OuterHttpThreadStore,
  params: OuterHttpInboundParams,
): Promise<OuterHttpInboundResult> {
  const parts = params.userMessagePersisted
    ? resolvePersistedParts(threadStore, params.threadId, params.senderSid)
    : resolveInboundParts(params);

  let messageId: string;
  if (params.userMessagePersisted) {
    const data = threadStore.loadThreads();
    const rawList = data.messages[params.threadId] ?? [];
    const lastParsed = MessageRecordSchema.parse(rawList[rawList.length - 1]!);
    messageId = lastParsed.message_id;
  } else {
    messageId = persistUserMessage(
      threadStore,
      params.threadId,
      params.senderSid,
      parts,
    );
  }

  const im = new CaptureImChannel();
  const brain = new OuterBrain({ ...deps, imClient: im });
  await brain.handleInbound({
    threadId: params.threadId,
    senderSid: params.senderSid,
    message: { message_id: messageId, parts },
    participantSids: params.participantSids,
  });

  return {
    threadId: params.threadId,
    messageId,
    replies: im.outbox.map((row) => ({
      threadId: row.threadId,
      senderSid: row.body.sender_sid,
      text: row.body.text,
      parts: row.body.parts,
      sentAt: row.at,
    })),
  };
}
