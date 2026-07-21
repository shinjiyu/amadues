/**
 * `WechatChannel` —— `ChatIRChannel` 的微信 iLink 实现（**每个微信号一个实例**）。
 *
 * - inbound：`WechatUpdateSource`（生产 = getupdates 长轮询，可注入 fake）
 *   → `handleWechatInbound` → 落 IR store → onAgentMessage
 * - outbound：postMessage → sendmessage（**必须回传**入站缓存的 context_token）
 * - typing：getconfig 拿 typing_ticket（按 thread 缓存）+ sendtyping status=1/0
 *
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6 P4b
 */
import {
  MessageRecordSchema,
  mentionTargetSidsFromParts,
  type ChatIRChannel,
  type ChatIRInboundEvent,
  type ChatIROutboundBody,
  type ChatIRSeenTracker,
  type IdentityBindingIndex,
  type IdentityRegistry,
  type LooseThreadStore,
  type MessagePart,
  type MessageRecord,
} from '@utlra/chat-ir';
import type { WechatConnectionConfig } from './config.js';
import { IlinkApiClient, IlinkApiError, type WeixinMessage } from './ilink-api-client.js';
import { handleWechatInbound } from './inbound.js';
import { irThreadToWechat, wechatMessageIdToIr } from './thread-mapper.js';

/** 消息来源抽象：生产 = 长轮询循环；单测注入 fake。 */
export interface WechatUpdateSource {
  start(onMessages: (msgs: WeixinMessage[]) => Promise<void>): void;
  stop(): void;
}

/** getupdates 游标持久化（bot 粒度；-14 重登时应清空） */
export interface WechatCursorStore {
  load(): string;
  save(buf: string): void;
}

export function memoryCursorStore(initial = ''): WechatCursorStore {
  let buf = initial;
  return {
    load: () => buf,
    save: (b) => {
      buf = b;
    },
  };
}

export interface LongPollSourceOptions {
  /** connect 探测已消费的一批消息（避免丢失，start 时先派发） */
  primeMessages?: WeixinMessage[];
  /** session 过期（-14）回调：连接应标记 down */
  onSessionExpired?: (err: IlinkApiError) => void;
  /** 轮询间隔基准（测试注入 0） */
  idleDelayMs?: number;
}

/** 生产事件源：getupdates 长轮询循环 + 游标持久化 + 退避。 */
export function createLongPollUpdateSource(
  api: IlinkApiClient,
  cursor: WechatCursorStore,
  opts: LongPollSourceOptions = {},
): WechatUpdateSource {
  let running = false;
  const idleDelay = opts.idleDelayMs ?? 1000;

  return {
    start(onMessages) {
      if (running) return;
      running = true;
      void (async () => {
        if (opts.primeMessages?.length) {
          await onMessages(opts.primeMessages).catch((e) =>
            console.error('[wechat-bridge] prime dispatch failed', e),
          );
        }
        let consecutiveFailures = 0;
        while (running) {
          try {
            const result = await api.getUpdates(cursor.load());
            consecutiveFailures = 0;
            if (result.buf) cursor.save(result.buf);
            if (result.msgs.length) await onMessages(result.msgs);
            else await sleep(idleDelay);
          } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') continue; // 空轮询
            if (e instanceof IlinkApiError && e.sessionExpired) {
              console.error('[wechat-bridge] session expired (-14)，停止轮询，需重新扫码');
              running = false;
              opts.onSessionExpired?.(e);
              return;
            }
            consecutiveFailures += 1;
            const backoff = consecutiveFailures >= 3 ? 30_000 : 2_000;
            console.warn(`[wechat-bridge] getupdates failed (${consecutiveFailures})，${backoff}ms 后重试`, String(e));
            await sleep(backoff);
          }
        }
      })();
    },
    stop() {
      running = false;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface WechatChannelOptions {
  config: WechatConnectionConfig;
  agentSid: string;
  tenant?: string;
  registry: IdentityRegistry;
  bindingIndex?: IdentityBindingIndex | null;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  seenTracker: ChatIRSeenTracker;
  onAgentMessage: (ev: ChatIRInboundEvent) => Promise<void>;
  updateSource: WechatUpdateSource;
  /** 复用 connector 探测时建的 client；缺省自建 */
  apiClient?: IlinkApiClient;
  fetchImpl?: typeof fetch;
}

export class WechatChannel implements ChatIRChannel {
  private readonly api: IlinkApiClient;
  private readonly seenMessageIds = new Set<string>();
  /** thread → 最近入站 context_token（出站回传） */
  private readonly contextTokens = new Map<string, string>();
  /** thread → typing_ticket 缓存（约 24h 有效，失败时清掉重取） */
  private readonly typingTickets = new Map<string, string>();
  private readonly typingOn = new Set<string>();
  private started = false;

  constructor(private readonly opts: WechatChannelOptions) {
    this.api =
      opts.apiClient ??
      new IlinkApiClient(
        { botToken: opts.config.botToken, ...(opts.config.baseUrl ? { baseUrl: opts.config.baseUrl } : {}) },
        opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
      );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.opts.updateSource.start(async (msgs) => {
      for (const msg of msgs) {
        try {
          await this.ingest(msg);
        } catch (e) {
          console.error(`[wechat-channel:${this.opts.config.botId}] inbound failed`, e);
        }
      }
    });
    console.log(`[wechat-channel] started bot=${this.opts.config.botId}`);
  }

  destroy(): void {
    this.started = false;
    this.opts.updateSource.stop();
  }

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    const route = irThreadToWechat(threadId);
    if (!route) {
      console.warn(`[wechat-channel:${this.opts.config.botId}] postMessage: not a wechat thread ${threadId}`);
      return;
    }
    if (route.botId !== this.opts.config.botId) {
      console.warn(`[wechat-channel:${this.opts.config.botId}] postMessage: thread belongs to bot ${route.botId}, skip`);
      return;
    }

    const parts = this.resolveParts(body);
    if (parts.length === 0) return;
    const text = renderWechatText(parts);
    const contextToken = this.contextTokens.get(threadId);
    if (!contextToken) {
      console.warn(`[wechat-channel:${this.opts.config.botId}] postMessage: no context_token for ${threadId}（等待用户先发言）`);
      return;
    }
    try {
      const sent = await this.api.sendTextMessage({
        toUserId: route.peerId,
        text,
        contextToken,
      });
      this.persistOutboundMessage(threadId, sent.clientId, body.sender_sid, parts);
      this.setTyping(threadId, false);
      console.log(`[wechat-channel:${this.opts.config.botId}] → wechat ${route.peerId} msg ${sent.clientId}`);
    } catch (e) {
      console.error(`[wechat-channel:${this.opts.config.botId}] postMessage failed`, e);
    }
  }

  /** Typing：getconfig 拿 ticket（缓存）→ sendtyping。全 best-effort。 */
  sendActivity(threadId: string, kind: 'typing' | 'idle'): void {
    this.setTyping(threadId, kind === 'typing');
  }

  private setTyping(threadId: string, on: boolean): void {
    if (!on && !this.typingOn.has(threadId)) return;
    const route = irThreadToWechat(threadId);
    if (!route || route.kind !== 'dm') return;
    if (on) this.typingOn.add(threadId);
    else this.typingOn.delete(threadId);
    void (async () => {
      try {
        let ticket = this.typingTickets.get(threadId);
        if (!ticket) {
          const fetched = await this.api.getTypingTicket(
            route.peerId,
            this.contextTokens.get(threadId),
          );
          if (!fetched) return;
          ticket = fetched;
          this.typingTickets.set(threadId, ticket);
        }
        await this.api.sendTyping(route.peerId, ticket, on);
      } catch (e) {
        this.typingTickets.delete(threadId);
        console.warn(`[wechat-channel:${this.opts.config.botId}] typing failed`, String(e));
      }
    })();
  }

  private async ingest(msg: WeixinMessage): Promise<void> {
    await handleWechatInbound(
      {
        botId: this.opts.config.botId,
        tenant: this.opts.tenant ?? 'default',
        agentSid: this.opts.agentSid,
        registry: this.opts.registry,
        ...(this.opts.bindingIndex != null ? { bindingIndex: this.opts.bindingIndex } : {}),
        loadThreads: this.opts.loadThreads,
        saveThreads: this.opts.saveThreads,
        seenMessageIds: this.seenMessageIds,
        contextTokens: this.contextTokens,
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
      msg,
    );
  }

  private resolveParts(body: ChatIROutboundBody): MessagePart[] {
    const text = body.text?.trim();
    const rawParts = Array.isArray(body.parts) ? (body.parts as MessagePart[]) : [];
    if (rawParts.length > 0) return rawParts;
    if (!text) return [];
    return [{ type: 'text', text }];
  }

  private persistOutboundMessage(
    irThreadId: string,
    clientId: string,
    senderSid: string,
    parts: MessagePart[],
  ): void {
    const store = this.opts.loadThreads();
    if (!store.messages[irThreadId]) store.messages[irThreadId] = [];
    const messageRecord: MessageRecord = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: wechatMessageIdToIr(this.opts.config.botId, clientId),
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

/** IR parts → 微信纯文本（微信无 at 标签协议，mention 渲染为 @label） */
export function renderWechatText(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === 'text') chunks.push(p.text);
    else if (p.type === 'mention') chunks.push(p.label ? `@${p.label}` : '');
    else if (p.type === 'attachment') {
      const name = p.asset_ref.name ?? p.asset_ref.uri;
      chunks.push(`[附件 ${name}]`);
    }
  }
  return chunks.join('');
}
