/**
 * `FeishuChannel` —— `ChatIRChannel` 的飞书实现（**每个 app 连接一个实例**，非单例）。
 *
 * - inbound：`FeishuEventSource`（长连接/webhook，可注入）→ `handleFeishuInbound`
 *   → 落 IR store → onAgentMessage（通常是 fanIn.makeInboundHandler(connectionId)）
 * - outbound：postMessage → 飞书 REST 发文本（@ 渲染为 `<at>` 标签）；
 *   parent 有 reply_to 时走 reply 接口
 * - typing：无原生 API → 对 thread 最后一条人类消息打 `Typing` 表情回复，
 *   idle / 回复发出后撤掉（channel-bridge-guide §5.4；全部 best-effort）
 *
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5
 */
import {
  MessageRecordSchema,
  ThreadRecordSchema,
  plainTextToPartsWithMentions,
  mentionTargetSidsFromParts,
  type ChatIRChannel,
  type ChatIRInboundEvent,
  type ChatIROutboundBody,
  type ChatIRSeenTracker,
  type IdentityBindingIndex,
  type IdentityRegistry,
  type LooseThreadStore,
  type MentionResolutionOptions,
  type MessagePart,
  type MessageRecord,
} from '@utlra/chat-ir';
import type { FeishuConnectionConfig } from './config.js';
import { FeishuApiClient } from './api-client.js';
import { handleFeishuInbound, type FeishuInboundEvent } from './inbound.js';
import { sidToFeishuOpenId } from './identity-mapper.js';
import {
  feishuMessageIdToIr,
  irMessageIdToFeishu,
  irThreadToFeishuChat,
} from './thread-mapper.js';

/**
 * 事件来源抽象：生产环境用飞书长连接 SDK / webhook，单测注入 fake。
 * `start` 收一个回调，收到 `im.message.receive_v1` 时调用。
 */
export interface FeishuEventSource {
  start(onEvent: (ev: FeishuInboundEvent) => Promise<void>): void;
  stop(): void;
}

export interface FeishuChannelOptions {
  config: FeishuConnectionConfig;
  /** 本连接 bot 的 open_id（connector 探测时得到） */
  botOpenId: string;
  agentSid: string;
  registry: IdentityRegistry;
  bindingIndex?: IdentityBindingIndex | null;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  seenTracker: ChatIRSeenTracker;
  onAgentMessage: (ev: ChatIRInboundEvent) => Promise<void>;
  eventSource: FeishuEventSource;
  /** 复用 connector 探测时建的 client；缺省时自建 */
  apiClient?: FeishuApiClient;
  fetchImpl?: typeof fetch;
}

const TYPING_EMOJI = 'Typing';

export class FeishuChannel implements ChatIRChannel {
  private readonly api: FeishuApiClient;
  private readonly seenEventIds = new Set<string>();
  /** thread → 最后一条人类消息的飞书 native message_id */
  private readonly lastHumanMessageId = new Map<string, string>();
  /** thread → 进行中的 typing reaction（幂等 + 撤销） */
  private readonly typingReactions = new Map<string, { messageId: string; reactionId: string }>();
  private started = false;

  constructor(private readonly opts: FeishuChannelOptions) {
    this.api =
      opts.apiClient ??
      new FeishuApiClient(opts.config, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.opts.eventSource.start(async (ev) => {
      try {
        await this.ingest(ev);
      } catch (e) {
        console.error(`[feishu-channel:${this.opts.config.appId}] inbound failed`, e);
      }
    });
    console.log(`[feishu-channel] started app=${this.opts.config.appId} bot=${this.opts.botOpenId}`);
  }

  destroy(): void {
    this.started = false;
    this.opts.eventSource.stop();
  }

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    const route = irThreadToFeishuChat(threadId);
    if (!route) {
      console.warn(`[feishu-channel:${this.opts.config.appId}] postMessage: not a feishu thread ${threadId}`);
      return;
    }
    if (route.appId !== this.opts.config.appId) {
      console.warn(
        `[feishu-channel:${this.opts.config.appId}] postMessage: thread belongs to app ${route.appId}, skip`,
      );
      return;
    }

    const parts = this.resolveParts(threadId, body);
    if (parts.length === 0) return;
    const contentJson = renderFeishuTextContent(parts, this.opts.registry);

    // 回复语义：parts 携带 reply_to（reply.v1 场景）时走 reply 接口
    const replyTo = extractReplyTo(body);
    try {
      const sent = replyTo
        ? await this.api.replyTextMessage(replyTo, contentJson)
        : await this.api.sendTextMessage(route.chatId, contentJson);
      this.persistOutboundMessage(threadId, sent.message_id, body.sender_sid, parts);
      // 回复已发出 = 不再"打字"
      this.clearTyping(threadId);
      console.log(
        `[feishu-channel:${this.opts.config.appId}] → feishu ${route.chatId} msg ${sent.message_id}`,
      );
    } catch (e) {
      console.error(`[feishu-channel:${this.opts.config.appId}] postMessage failed`, e);
    }
  }

  /**
   * Typing 模拟：对 thread 最后一条人类消息打/撤 `Typing` 表情。
   * 全 best-effort：无目标消息 / API 失败只记日志。
   */
  sendActivity(threadId: string, kind: 'typing' | 'idle'): void {
    if (kind === 'idle') {
      this.clearTyping(threadId);
      return;
    }
    const targetMessageId = this.lastHumanMessageId.get(threadId);
    if (!targetMessageId) return;
    const existing = this.typingReactions.get(threadId);
    if (existing && existing.messageId === targetMessageId) return; // 幂等
    void (async () => {
      try {
        if (existing) await this.api.deleteReaction(existing.messageId, existing.reactionId).catch(() => {});
        const reactionId = await this.api.createReaction(targetMessageId, TYPING_EMOJI);
        this.typingReactions.set(threadId, { messageId: targetMessageId, reactionId });
      } catch (e) {
        console.warn(`[feishu-channel:${this.opts.config.appId}] typing reaction failed`, String(e));
      }
    })();
  }

  private clearTyping(threadId: string): void {
    const r = this.typingReactions.get(threadId);
    if (!r) return;
    this.typingReactions.delete(threadId);
    void this.api.deleteReaction(r.messageId, r.reactionId).catch((e) => {
      console.warn(`[feishu-channel:${this.opts.config.appId}] delete typing reaction failed`, String(e));
    });
  }

  private async ingest(ev: FeishuInboundEvent): Promise<void> {
    await handleFeishuInbound(
      {
        appId: this.opts.config.appId,
        tenant: this.opts.config.tenant ?? 'default',
        agentSid: this.opts.agentSid,
        botOpenId: this.opts.botOpenId,
        registry: this.opts.registry,
        ...(this.opts.bindingIndex != null ? { bindingIndex: this.opts.bindingIndex } : {}),
        loadThreads: this.opts.loadThreads,
        saveThreads: this.opts.saveThreads,
        seenEventIds: this.seenEventIds,
        lastHumanMessageId: this.lastHumanMessageId,
        onMessagePersisted: async (persisted) => {
          this.opts.seenTracker.track(persisted.threadId, {
            message_id: persisted.message.message_id,
            sender_sid: persisted.senderSid,
            mention_target_sids: mentionTargetSidsFromParts(
              persisted.message.parts as Array<{ type: string; target_sid?: string }>,
            ),
          });
          if (persisted.senderSid === this.opts.agentSid) return;
          await this.opts.onAgentMessage({
            threadId: persisted.threadId,
            senderSid: persisted.senderSid,
            message: persisted.message,
            participantSids: persisted.participantSids,
          });
        },
      },
      ev,
    );
  }

  private resolveParts(threadId: string, body: ChatIROutboundBody): MessagePart[] {
    const text = body.text?.trim();
    const rawParts = Array.isArray(body.parts) ? (body.parts as MessagePart[]) : [];
    const mentionOpts = this.resolveMentionOptions(threadId);

    if (rawParts.length > 0) {
      if (!text || body.parse_mentions === false) return rawParts;
      const parsedText = plainTextToPartsWithMentions(text, this.opts.registry, mentionOpts);
      const head = rawParts[0];
      if (head && head.type === 'text' && head.text === text) {
        return [...parsedText, ...rawParts.slice(1)];
      }
      return [...parsedText, ...rawParts];
    }
    if (!text) return [];
    if (body.parse_mentions === false) return [{ type: 'text', text }];
    return plainTextToPartsWithMentions(text, this.opts.registry, mentionOpts);
  }

  private resolveMentionOptions(threadId: string): MentionResolutionOptions {
    try {
      const store = this.opts.loadThreads();
      const thread = store.threads
        .map((item) => ThreadRecordSchema.safeParse(item))
        .find((parsed) => parsed.success && parsed.data.thread_id === threadId);
      return {
        participantSids: thread?.success ? thread.data.participant_sids : [],
        preferredChannels: ['feishu'],
      };
    } catch {
      return { preferredChannels: ['feishu'] };
    }
  }

  private persistOutboundMessage(
    irThreadId: string,
    nativeMessageId: string,
    senderSid: string,
    parts: MessagePart[],
  ): void {
    const store = this.opts.loadThreads();
    if (!store.messages[irThreadId]) store.messages[irThreadId] = [];
    const messageRecord: MessageRecord = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: feishuMessageIdToIr(this.opts.config.appId, nativeMessageId),
      thread_id: irThreadId,
      sender_sid: senderSid,
      sent_at: new Date().toISOString(),
      parts,
    });
    store.messages[irThreadId]!.push(messageRecord);
    this.opts.saveThreads(store);
    this.opts.seenTracker.track(irThreadId, {
      message_id: messageRecord.message_id,
      sender_sid: senderSid,
      mention_target_sids: mentionTargetSidsFromParts(parts),
    });
  }
}

/** IR parts → 飞书 text 消息 content JSON（mention → `<at>` 标签） */
export function renderFeishuTextContent(parts: MessagePart[], registry: IdentityRegistry): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      chunks.push(p.text);
    } else if (p.type === 'mention') {
      const openId = sidToFeishuOpenId(p.target_sid, registry);
      if (openId) {
        chunks.push(`<at user_id="${openId}">${p.label ?? ''}</at>`);
      } else if (p.label) {
        chunks.push(`@${p.label}`);
      }
    } else if (p.type === 'attachment') {
      const name = p.asset_ref.name ?? p.asset_ref.uri;
      chunks.push(`[附件 ${name}]`);
    }
  }
  return JSON.stringify({ text: chunks.join('') });
}

function extractReplyTo(body: ChatIROutboundBody): string | null {
  const parts = Array.isArray(body.parts) ? (body.parts as MessagePart[]) : [];
  for (const p of parts) {
    if (p.type === 'quote' && p.quoted_message_id) {
      const native = irMessageIdToFeishu(p.quoted_message_id);
      if (native) return native.messageId;
    }
  }
  return null;
}
