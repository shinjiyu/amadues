/**
 * `WebChatChannel` —— `ChatIRChannel` 的 WebChat 实现。
 *
 * 通过 HTTP REST + WebSocket 对接独立 `chat-server` 进程，行为与 `DiscordChannel`
 * 同构（见 packages/discord-bridge/src/discord-channel.ts）：
 *
 * - inbound：WS `message.new` → `handleWebChatInbound` → 翻译为 `MessageRecord` →
 *   落 chat IR store → 触发 `onAgentMessage`（过滤自己发的）
 * - outbound：agent 调 `postMessage(threadId, body)` → 翻译为 chat-server
 *   `PostMessageRequest` → POST `/threads/:id/messages` → 同时落 store
 *
 * thread_id 映射：IR thread_id 加 `webchat:` 前缀（避免与其它渠道冲突）；
 * chat-server 端使用裸的 `global` / `dm:a:b`。
 */
import { randomUUID } from 'node:crypto';
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
  type LooseThreadStore,
  type MentionResolutionOptions,
  type MessagePart,
  type MessageRecord,
  mentionTargetSidsFromParts,
} from '@utlra/chat-ir';
import type { Thread as WebChatThread, Message as WebChatMessage } from '@utlra/webchat-protocol';
import type { WebChatBridgeConfig } from './config.js';
import { WebChatRestClient, absoluteAttachmentUrl } from './rest-client.js';
import { WebChatWsClient, type ConnectionStatus } from './ws-client.js';
import { handleWebChatInbound } from './inbound.js';
import { webChatUserToSid } from './identity-mapper.js';
import {
  irThreadToWebChat,
  webChatMessageIdToIr,
  webChatThreadToIr,
} from './thread-mapper.js';
import { ensureWebChatAttachmentUploads } from './asset-upload.js';
import { renderForWebChat } from './reply-render.js';

export interface WebChatChannelOptions {
  config: WebChatBridgeConfig;
  agentSid: string;
  dataRoot: string;
  registry: IdentityRegistry;
  assetStore: ChatAssetStore;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  seenTracker: ChatIRSeenTracker;
  onAgentMessage: (ev: ChatIRInboundEvent) => Promise<void>;
  fetchImpl?: typeof fetch;
}

function agentParticipatesInThread(
  participantSids: string[],
  agentSid: string,
  agentUserId: string,
): boolean {
  if (participantSids.length === 0) return true;
  if (participantSids.includes(agentSid)) return true;
  const primaryUserId = agentUserId.split(',')[0]?.trim();
  if (primaryUserId && participantSids.includes(webChatUserToSid(primaryUserId))) return true;
  return false;
}

export class WebChatChannel implements ChatIRChannel {
  private readonly rest: WebChatRestClient;
  private readonly ws: WebChatWsClient;

  /** chat-server 端线程元数据缓存（首次启动 + 入站 thread.kind 检测时填充）。 */
  private threadMetaCache = new Map<string, WebChatThread>();
  /** 已订阅的 chat-server thread_id → 最后已知 message_id（用于重连 since 补拉）。 */
  private subscriptions = new Map<string, string | null>();
  /** 已下载过的 chat-server URL → asset_id（出站时若复用同一 URI 可省去重复上传）。 */
  private uploadedAssetByUri = new Map<string, string>();
  /** 记录我们刚发出的 chat-server message_id；入站事件命中就跳过避免回声重复处理。 */
  private outboundEchoSet = new Set<string>();

  private started = false;
  private status: ConnectionStatus = 'idle';
  /** 对照 chat-server /me.online，修复 WS 半开导致 UI 显示离线 */
  private presenceWatchTimer: NodeJS.Timeout | null = null;
  private static readonly PRESENCE_WATCH_MS = 60_000;

  constructor(private readonly opts: WebChatChannelOptions) {
    this.rest = new WebChatRestClient({
      config: opts.config,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.ws = new WebChatWsClient({
      url: opts.config.wsUrl,
      userId: opts.config.agentUserId,
      displayName: opts.config.agentDisplayName,
      agentSecret: opts.config.agentSecret,
      getResubscriptions: () =>
        Array.from(this.subscriptions.entries()).map(([threadId, cursor]) => ({
          threadId,
          cursor,
        })),
      onStatusChange: (s) => {
        this.status = s;
      },
      onEvent: (ev) => {
        void this.handleServerEvent(ev).catch((e) => {
          console.error('[webchat-channel] handle event failed', e);
        });
      },
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.bootstrap().catch((e) => {
      console.error('[webchat-channel] bootstrap failed (channel disabled until reconnect)', e);
    });
  }

  destroy(): void {
    this.started = false;
    this.stopPresenceWatch();
    this.ws.close();
  }

  /** 供运维/调试：WS 是否 ready（与 chat-server presence.online 一致） */
  getWebChatConnectionStatus(): { status: ConnectionStatus; ready: boolean } {
    return { status: this.status, ready: this.ws.isOpen() };
  }

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    const webChatThreadId = irThreadToWebChat(threadId) ?? threadId;
    // 兜底：调用方传了已经是 chat-server 形态的 thread_id（例如 `global`），也允许

    const parts = this.resolveParts(threadId, body);
    if (parts.length === 0) {
      console.warn('[webchat-channel] postMessage: empty parts, skip');
      return;
    }

    const uploadFailed = await ensureWebChatAttachmentUploads(parts, {
      assetStore: this.opts.assetStore,
      rest: this.rest,
      uploadedAssetByUri: this.uploadedAssetByUri,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });

    const rendered = renderForWebChat({
      parts,
      registry: this.opts.registry,
      uploadedAssetByUri: this.uploadedAssetByUri,
    });

    if (uploadFailed.length > 0 || rendered.pendingAssetUris.length > 0) {
      const pending = [...new Set([...uploadFailed, ...rendered.pendingAssetUris])];
      console.warn(
        `[webchat-channel] postMessage: ${pending.length} attachment(s) not delivered to chat-server: ${pending.join(', ')}`,
      );
    }

    try {
      const res = await this.rest.postMessage(webChatThreadId, {
        client_msg_id: randomUUID(),
        text: rendered.text,
        ...(rendered.mentionUserIds.length > 0 ? { mention_user_ids: rendered.mentionUserIds } : {}),
        ...(rendered.attachmentIds.length > 0 ? { attachment_ids: rendered.attachmentIds } : {}),
        ...(rendered.replyToMessageId ? { reply_to_message_id: rendered.replyToMessageId } : {}),
      });
      const sent = res.message;
      this.outboundEchoSet.add(sent.id);
      this.persistOutboundMessage(threadId, sent, body.sender_sid);
      console.log(
        `[webchat-channel] → webchat ${webChatThreadId} msg ${sent.id} (ir thread ${threadId})`,
      );
    } catch (e) {
      console.error('[webchat-channel] postMessage failed', webChatThreadId, e);
    }
  }

  /**
   * 活动信号 → chat-server typing.relay。瞬时、不落库、best-effort。
   * IR `typing` → REST `start`，`idle` → REST `stop`。
   */
  sendActivity(threadId: string, kind: 'typing' | 'idle'): void {
    const webChatThreadId = irThreadToWebChat(threadId) ?? threadId;
    const state = kind === 'typing' ? 'start' : 'stop';
    void this.rest.sendTyping(webChatThreadId, state).catch((e) => {
      // typing 是锦上添花信号，失败仅 debug 级别，不影响主流程
      console.warn('[webchat-channel] sendTyping failed', webChatThreadId, state, String(e));
    });
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.rest.me();
    } catch (e) {
      console.warn('[webchat-channel] me() failed; will retry via WS', e);
    }
    try {
      const { threads } = await this.rest.listThreads();
      for (const t of threads) {
        this.threadMetaCache.set(t.id, t);
        this.subscribeThread(t.id);
      }
    } catch (e) {
      console.warn('[webchat-channel] initial listThreads failed', e);
      this.subscribeThread(this.opts.config.globalThreadId);
    }
    this.ws.connect();
    this.startPresenceWatch();
    console.log(
      `[webchat-channel] started agent=${this.opts.config.agentUserId} api=${this.opts.config.apiBase} ws=${this.opts.config.wsUrl}`,
    );
  }

  private startPresenceWatch(): void {
    this.stopPresenceWatch();
    this.presenceWatchTimer = setInterval(() => {
      void this.tickPresenceWatch().catch((e) => {
        console.warn('[webchat-channel] presence watch failed', e);
      });
    }, WebChatChannel.PRESENCE_WATCH_MS);
  }

  private stopPresenceWatch(): void {
    if (this.presenceWatchTimer) {
      clearInterval(this.presenceWatchTimer);
      this.presenceWatchTimer = null;
    }
  }

  private async tickPresenceWatch(): Promise<void> {
    if (!this.started) return;
    if (!this.ws.isOpen()) {
      if (this.ws.getStatus() === 'open' || this.ws.getStatus() === 'connecting') {
        this.ws.reconnectNow('presence_watch_not_ready');
      } else {
        this.ws.connect();
      }
      return;
    }
    try {
      const me = await this.rest.me();
      if (!me.online) {
        console.warn(
          `[webchat-channel] presence drift: WS ready but /me online=false agent=${this.opts.config.agentUserId}, reconnecting`,
        );
        this.ws.reconnectNow('presence_drift');
      }
    } catch {
      /* REST 暂不可达时不误杀 WS */
    }
  }

  private subscribeThread(chatServerThreadId: string): void {
    if (!this.subscriptions.has(chatServerThreadId)) {
      this.subscriptions.set(chatServerThreadId, null);
    }
    if (this.ws.isOpen()) {
      this.ws.send({ type: 'subscribe', thread_id: chatServerThreadId });
    }
  }

  private async handleServerEvent(
    ev: import('@utlra/webchat-protocol').ServerEvent,
  ): Promise<void> {
    if (ev.type === 'message.new') {
      // 自己发出的回声（postMessage 内已落库 + tracked）跳过
      if (this.outboundEchoSet.has(ev.message.id)) {
        this.outboundEchoSet.delete(ev.message.id);
        this.subscriptions.set(ev.thread_id, ev.message.id);
        return;
      }
      // 发现新线程：缓存元数据并订阅
      if (!this.threadMetaCache.has(ev.thread_id)) {
        try {
          const { threads } = await this.rest.listThreads();
          for (const t of threads) this.threadMetaCache.set(t.id, t);
          if (!this.subscriptions.has(ev.thread_id)) this.subscribeThread(ev.thread_id);
        } catch { /* ignore */ }
      }
      await this.ingestInboundMessage(ev.message);
      this.subscriptions.set(ev.thread_id, ev.message.id);
    } else if (ev.type === 'presence.sync') {
      // 已知用户写进 registry 便于 mention 解析（display_name → sid）
      for (const u of ev.users) {
        upsertHumanLite(this.opts.registry, u.user_id, u.display_name, this.opts.config.tenant);
      }
    } else if (ev.type === 'presence.update') {
      upsertHumanLite(this.opts.registry, ev.user_id, ev.display_name, this.opts.config.tenant);
    } else if (ev.type === 'error') {
      console.warn('[webchat-channel] server error', ev.code, ev.message);
    }
  }

  private async ingestInboundMessage(msg: WebChatMessage): Promise<void> {
    await handleWebChatInbound(
      {
        config: this.opts.config,
        agentSid: this.opts.agentSid,
        registry: this.opts.registry,
        assetStore: this.opts.assetStore,
        loadThreads: this.opts.loadThreads,
        saveThreads: this.opts.saveThreads,
        rest: this.rest,
        resolveThreadMeta: (tid) => this.threadMetaCache.get(tid),
        lookupDisplayName: (uid) => {
          // 优先 registry display_name
          return this.opts.registry.get(`webchat:user:${uid}`)?.display_name ?? uid;
        },
        onMessagePersisted: async (ev) => {
          this.opts.seenTracker.track(ev.threadId, {
            message_id: ev.message.message_id,
            sender_sid: ev.senderSid,
            mention_target_sids: mentionTargetSidsFromParts(
              ev.message.parts as Array<{ type: string; target_sid?: string }>,
            ),
          });
          if (ev.senderSid === this.opts.agentSid) return;
          if (
            !agentParticipatesInThread(
              ev.participantSids,
              this.opts.agentSid,
              this.opts.config.agentUserId,
            )
          ) {
            return;
          }
          await this.opts.onAgentMessage({
            threadId: ev.threadId,
            senderSid: ev.senderSid,
            message: ev.message,
            participantSids: ev.participantSids,
          });
        },
      },
      msg,
    );
  }

  /**
   * agent 出站 body 翻译成 IR parts（与 DiscordChannel.resolveParts 同构）：
   *
   * - `parse_mentions !== false` 时，text 中的 `@xxx` 会通过
   *   `plainTextToPartsWithMentions` 解析为结构化 mention part；
   *   解析依赖 `IdentityRegistry`，并把当前 thread 的 `participant_sids` +
   *   `preferredChannels: ['webchat']` 作为消歧上下文。
   * - 给了 `parts` 时以 parts 为准；若同时给了 text 且 parts 首项是该 text，
   *   则把首项替换为解析后的 mention parts，以便 LLM 输出 `@xxx 你好` 时
   *   能正确高亮（与 Discord 行为一致）。
   *
   * 这步**必须做**，否则 LLM 输出的 `@shinjiyu` 只是一段普通文本，chat-server
   * 端拿不到 `mention_user_ids`，前端也不会渲染成 mention 高亮。
   */
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
        preferredChannels: ['webchat'],
      };
    } catch {
      return { preferredChannels: ['webchat'] };
    }
  }

  private hasLeadingTextPart(parts: MessagePart[], text: string): boolean {
    const head = parts[0];
    return !!head && head.type === 'text' && head.text === text;
  }

  /**
   * 出站消息发送成功后，把它落进 Kuroneko 的 chat IR store + seenTracker。
   * 入站 echo 也会触发同样流程，我们用 `outboundEchoSet` 去重避免双写。
   */
  private persistOutboundMessage(
    irThreadId: string,
    sent: WebChatMessage,
    senderSid: string,
  ): void {
    const store = this.opts.loadThreads();
    let threadRecord = findThreadInStore(store, irThreadId);
    if (!threadRecord) {
      // 与入站逻辑保持一致：若线程不存在，建一个
      const meta = this.threadMetaCache.get(sent.thread_id);
      threadRecord = {
        schema: 'thread.v1',
        thread_id: irThreadId,
        tenant_id: this.opts.config.tenant,
        channel: 'webchat',
        kind: meta?.kind === 'dm' ? 'dm' : 'group',
        ...(meta?.title ? { title: meta.title } : {}),
        participant_sids: [this.opts.agentSid],
        created_at: new Date().toISOString(),
      };
      store.threads.push(threadRecord);
    }
    if (!store.messages[irThreadId]) store.messages[irThreadId] = [];

    const parts: MessagePart[] = [];
    for (const p of sent.parts) {
      if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      else if (p.type === 'mention') {
        const targetSid = `webchat:user:${p.user_id}`;
        parts.push({ type: 'mention', target_sid: targetSid, label: p.display_name });
      } else if (p.type === 'attachment') {
        const a = p.attachment;
        const uri = absoluteAttachmentUrl(this.opts.config.apiBase, a.url);
        parts.push({
          type: 'attachment',
          asset_ref: {
            kind: kindFromMime(a.mime),
            uri,
            mime: a.mime,
            name: a.name,
          },
        });
      }
    }

    const messageRecord: MessageRecord = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: webChatMessageIdToIr(sent.id),
      thread_id: irThreadId,
      sender_sid: senderSid,
      sent_at: sent.sent_at,
      ...(sent.reply_to_message_id
        ? { reply_to_message_id: webChatMessageIdToIr(sent.reply_to_message_id) }
        : {}),
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

function findThreadInStore(store: LooseThreadStore, threadId: string) {
  for (const t of store.threads) {
    const p = ThreadRecordSchema.safeParse(t);
    if (p.success && p.data.thread_id === threadId) return p.data;
  }
  return undefined;
}

function kindFromMime(mime: string): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function upsertHumanLite(
  registry: IdentityRegistry,
  userId: string,
  displayName: string,
  tenant: string,
): void {
  const sid = `webchat:user:${userId}`;
  const prev = registry.get(sid);
  if (prev && prev.display_name === displayName) return;
  try {
    registry.upsert({
      schema: 'identity.v1',
      sid,
      kind: 'human',
      display_name: displayName || userId,
      aliases: prev?.aliases ?? [],
      roles_in_tenant: prev?.roles_in_tenant ?? ['member'],
      bindings: prev?.bindings ?? [
        { channel: 'webchat', native_user_id: userId, ...(tenant ? { native_union_id: tenant } : {}) },
      ],
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[webchat-channel] upsertHumanLite failed', sid, e);
  }
}

// thread_id helpers re-export so callers can map IR ↔ chat-server
export { webChatThreadToIr, irThreadToWebChat };
