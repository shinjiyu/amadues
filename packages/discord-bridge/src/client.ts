/**
 * Discord Gateway 客户端：基于 discord.js v14。
 *
 * 暴露：
 *   - start(): 登录并开始接 MESSAGE_CREATE
 *   - sendToChannel(channelId, payload): 通过 REST 发消息（出站用）
 *   - destroy(): 清理
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type OmitPartialGroupDMChannel,
  type TextBasedChannel,
} from 'discord.js';
import type { DiscordBridgeConfig } from './config.js';
import type { RenderedDiscordPayload } from './reply-render.js';

export interface DiscordClientOptions {
  config: DiscordBridgeConfig;
  onMessage: (msg: OmitPartialGroupDMChannel<Message<boolean>>) => Promise<void>;
}

export class DiscordClient {
  private client: Client;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;

  constructor(private readonly opts: DiscordClientOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers, // 解析 guildNickname / mention 用户解引用
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 防御性兜底：若 start() 在 await readyPromise 前抛出，readyPromise 仍可能被 reject；
    // 必须挂个 noop catch 防止 unhandledRejection 把整个 agent 进程拖崩。
    this.readyPromise.catch(() => {
      /* swallow; 真正的错误通过 start() 的 throw 传出 */
    });

    this.client.once(Events.ClientReady, (c) => {
      console.log(
        `[discord-bridge] Discord ready as ${c.user.tag} (id=${c.user.id}). guilds=${c.guilds.cache.size}`,
      );
      this.resolveReady();
    });

    this.client.on(Events.Error, (e) => {
      console.error('[discord-bridge] discord.js error', e);
    });
    this.client.on(Events.Warn, (m) => {
      console.warn('[discord-bridge] discord.js warn', m);
    });
    this.client.on(Events.ShardError, (e) => {
      console.error('[discord-bridge] shard error', e);
    });

    this.client.on(Events.MessageCreate, (msg) => {
      void this.opts.onMessage(msg).catch((e) => {
        console.error('[discord-bridge] onMessage failed', e);
      });
    });
  }

  async start(): Promise<{ botUserId: string; botTag: string }> {
    try {
      await this.client.login(this.opts.config.token);
    } catch (e) {
      this.rejectReady(e);
      // 关键：彻底关掉 client，否则 discord.js 的 WebSocketManager 内部重连/事件
      // 仍会抛出未捕获异常（甚至触发 libuv 断言把整个 Node 进程干掉）。
      try {
        await this.client.destroy();
      } catch {
        /* ignore */
      }
      throw e;
    }
    await this.readyPromise;
    const u = this.client.user;
    if (!u) throw new Error('discord client has no user after ready');
    return { botUserId: u.id, botTag: u.tag };
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  /**
   * 通过 REST 把 payload 发到指定 channel（DM / Guild text / Thread 都行）。
   * 返回 discord message id；失败返回 null。
   */
  async sendToChannel(
    channelId: string,
    payload: RenderedDiscordPayload,
  ): Promise<string | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        console.warn(`[discord-bridge] channel ${channelId} not found`);
        return null;
      }
      if (!isSendableChannel(channel)) {
        console.warn(`[discord-bridge] channel ${channelId} is not text-based`);
        return null;
      }
      const sent = await channel.send({
        content: payload.content || ' ', // Discord 不允许空 content + 空 files
        files: payload.files.map((f) => ({
          attachment: f.attachment,
          name: f.name,
          ...(f.contentType ? { contentType: f.contentType } : {}),
        })),
        allowedMentions: {
          parse: ['users'],
          repliedUser: false,
        },
      });
      return sent.id;
    } catch (e) {
      console.error(`[discord-bridge] sendToChannel ${channelId} failed`, e);
      return null;
    }
  }
}

function isSendableChannel(c: unknown): c is TextBasedChannel & {
  send: (options: unknown) => Promise<{ id: string }>;
} {
  if (!c || typeof c !== 'object') return false;
  const obj = c as { isTextBased?: () => boolean; send?: unknown };
  if (typeof obj.send !== 'function') return false;
  if (typeof obj.isTextBased === 'function' && !obj.isTextBased()) return false;
  return true;
}
