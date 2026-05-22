/**
 * `DiscordChannel` —— `ChatIRChannel` 的 Discord 实现。
 *
 * 直接对接 Discord Gateway / REST，不经过任何中间 IM Server：
 * - inbound：Discord MESSAGE_CREATE → 进程内落 chat IR store → 触发 onAgentMessage callback
 * - outbound：agent 调 `postMessage(threadId, body)` → Discord REST → 同时落 store
 *
 * 持久化职责：调注入的 `loadThreads / saveThreads`（与 agent 进程共享同一份 `threads.json`）。
 * 身份职责：调注入的 `IdentityRegistry`（与 agent 进程共享 `identities.json`）。
 * 附件职责：调注入的 `ChatAssetStore`（与 agent 进程共享 `uploads/`）。
 */
import path from 'node:path';
import {
  MessageRecordSchema,
  ThreadRecordSchema,
  plainTextToPartsWithMentions,
  type ChatAssetStore,
  type ChatIRChannel,
  type ChatIRInboundEvent,
  type ChatIRInboundMessage,
  type ChatIROutboundBody,
  type ChatIRSeenTracker,
  type IdentityRegistry,
  type MentionResolutionOptions,
  type LooseThreadStore,
  type MessageRecord,
  type MessagePart,
} from '@utlra/chat-ir';
import { DiscordClient } from './client.js';
import { DiscordThreadMapper } from './thread-mapper.js';
import { handleDiscordMessage } from './inbound.js';
import { renderForDiscord } from './reply-render.js';
import type { DiscordBridgeConfig } from './config.js';

export interface DiscordChannelOptions {
  config: DiscordBridgeConfig;
  /** agent 自身的 sender_sid（用于过滤自己发的消息、识别 mention） */
  agentSid: string;
  /** 数据根（落 maps.json 用）；通常等于 UTLRA_DATA_ROOT */
  dataRoot: string;
  /** 跨渠道共享：身份注册表（写 identities.json） */
  registry: IdentityRegistry;
  /** 跨渠道共享：附件存储（写 uploads/） */
  assetStore: ChatAssetStore;
  /** 跨渠道共享：threads.json 读写 */
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  /**
   * 跨渠道共享：消息观察 tracker。本 channel 在入站落库后 + 出站发送成功后
   * 各调一次 `seenTracker.track(...)`。
   */
  seenTracker: ChatIRSeenTracker;
  /**
   * 收到应由 agent 处理的消息时调用（human → agent 私聊 / 群 @agent）。
   * 由本 channel 负责过滤"自己发的消息"和"agent 不在参与者"。
   */
  onAgentMessage: (ev: ChatIRInboundEvent) => Promise<void>;
  /** 自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

export class DiscordChannel implements ChatIRChannel {
  private readonly client: DiscordClient;
  private readonly mapper: DiscordThreadMapper;
  private botUserId: string | null = null;
  private started = false;

  constructor(private readonly opts: DiscordChannelOptions) {
    const mapsPath = path.join(opts.dataRoot, 'discord', 'maps.json');
    this.mapper = new DiscordThreadMapper(mapsPath);

    this.client = new DiscordClient({
      config: opts.config,
      onMessage: async (msg) => {
        if (!this.botUserId) return;
        await handleDiscordMessage(
          {
            config: opts.config,
            mapper: this.mapper,
            agentSid: opts.agentSid,
            botUserId: this.botUserId,
            registry: opts.registry,
            assetStore: opts.assetStore,
            loadThreads: opts.loadThreads,
            saveThreads: opts.saveThreads,
            onMessagePersisted: (ev) => this.handleInboundPersisted(ev),
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          },
          msg,
        );
      },
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.startAsync().catch((e) => {
      console.error('[discord-channel] start failed (channel disabled)', e);
    });
  }

  private async startAsync(): Promise<void> {
    const { botUserId, botTag } = await this.client.start();
    this.botUserId = botUserId;
    console.log(
      `[discord-channel] started as ${botTag} (uid=${botUserId})  agent=${this.opts.agentSid}  ingest=${this.opts.config.ingest}  guilds=${
        this.opts.config.guildAllowlist.length || 'all'
      }`,
    );
  }

  destroy(): void {
    void this.client.destroy().catch((e) => {
      console.error('[discord-channel] destroy failed', e);
    });
  }

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    const channelId = this.mapper.getChannelId(threadId);
    if (!channelId) {
      console.warn(
        `[discord-channel] postMessage: no channel binding for thread ${threadId} (agent may have generated a non-Discord thread)`,
      );
      return;
    }

    const parts = this.resolveParts(threadId, body);
    if (parts.length === 0) {
      console.warn('[discord-channel] postMessage: empty parts, skip');
      return;
    }

    const payload = renderForDiscord({ parts, assetStore: this.opts.assetStore, registry: this.opts.registry });
    if (!payload.content && payload.files.length === 0) {
      console.warn('[discord-channel] postMessage: rendered empty payload, skip');
      return;
    }

    const sentId = await this.sendToChannelSafe(channelId, payload);
    if (!sentId) return;

    this.mapper.rememberBotSent(sentId);

    const messageRecord: MessageRecord = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: `discord:${sentId}`,
      thread_id: threadId,
      sender_sid: body.sender_sid,
      sent_at: new Date().toISOString(),
      parts,
    });
    this.persistMessage(threadId, messageRecord);
    this.opts.seenTracker.track(threadId, {
      message_id: messageRecord.message_id,
      sender_sid: messageRecord.sender_sid,
    });
    console.log(
      `[discord-channel] → discord channel ${channelId} (thread ${threadId}) msg ${sentId}`,
    );
  }

  private async handleInboundPersisted(ev: {
    threadId: string;
    senderSid: string;
    message: ChatIRInboundMessage;
    participantSids: string[];
  }): Promise<void> {
    this.opts.seenTracker.track(ev.threadId, {
      message_id: ev.message.message_id,
      sender_sid: ev.senderSid,
    });

    if (ev.senderSid === this.opts.agentSid) return;
    if (ev.participantSids.length > 0 && !ev.participantSids.includes(this.opts.agentSid)) {
      return;
    }

    await this.opts.onAgentMessage({
      threadId: ev.threadId,
      senderSid: ev.senderSid,
      message: ev.message,
      participantSids: ev.participantSids,
    });
  }

  private resolveParts(threadId: string, body: ChatIROutboundBody): MessagePart[] {
    const text = body.text?.trim();
    const rawParts = Array.isArray(body.parts) ? (body.parts as MessagePart[]) : [];
    const mentionOpts = this.resolveMentionOptions(threadId);
    if (rawParts.length > 0) {
      if (!text || body.parse_mentions === false) return rawParts;
      const parsedText = plainTextToPartsWithMentions(text, this.opts.registry, mentionOpts);
      if (this.hasLeadingTextPart(rawParts, text)) {
        return [...parsedText, ...rawParts.slice(1)];
      }
      return [...parsedText, ...rawParts];
    }

    if (!text) return [];
    if (body.parse_mentions === false) {
      return [{ type: 'text', text }];
    }
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
        preferredChannels: ['discord'],
      };
    } catch {
      return { preferredChannels: ['discord'] };
    }
  }

  private hasLeadingTextPart(parts: MessagePart[], text: string): boolean {
    const first = parts[0];
    return first?.type === 'text' && first.text.trim() === text;
  }

  private persistMessage(threadId: string, rec: MessageRecord): void {
    const store = this.opts.loadThreads();
    if (!store.messages[threadId]) store.messages[threadId] = [];
    store.messages[threadId]!.push(rec);
    this.opts.saveThreads(store);
  }

  private async sendToChannelSafe(
    channelId: string,
    payload: { content: string; files: Array<{ attachment: Buffer; name: string; contentType?: string }> },
  ): Promise<string | null> {
    try {
      return await this.client.sendToChannel(channelId, payload);
    } catch (e) {
      console.error('[discord-channel] sendToChannel failed', e);
      return null;
    }
  }
}
