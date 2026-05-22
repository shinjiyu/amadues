/**
 * Discord channel ↔ IM thread 双向映射，落盘到 `<dataRoot>/discord/maps.json`。
 *
 * thread_id 由 DiscordChannel 在首次见到 channel 时新建（UUID），随后持久化映射；重启时仍能找回。
 *
 * message_id_map: 用 `discord:<discord_message_id>` 作为 IM `message_id` 前缀，
 * 既能从 IM 反查 Discord 原始 id（用于回复 / 引用），也能去重出站回声。
 */
import fs from 'node:fs';
import path from 'node:path';

interface MapsFile {
  /** thread_id → discord channel id */
  threadToChannel: Record<string, string>;
  /** discord channel id → thread_id */
  channelToThread: Record<string, string>;
  /**
   * 出站时记录我们刚发到 Discord 的 message_id（agent 的回复），
   * 用于过滤 Gateway 回声（防止把自己发的消息再次入站给 OuterBrain）。
   * 仅保留最近 N 条。
   */
  recentBotSentMessageIds: string[];
}

const RECENT_BOT_LIMIT = 200;

export class DiscordThreadMapper {
  private maps: MapsFile = {
    threadToChannel: {},
    channelToThread: {},
    recentBotSentMessageIds: [],
  };

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<MapsFile>;
      this.maps = {
        threadToChannel: raw.threadToChannel ?? {},
        channelToThread: raw.channelToThread ?? {},
        recentBotSentMessageIds: raw.recentBotSentMessageIds ?? [],
      };
    } catch {
      /* 损坏文件不致命，重建即可 */
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.maps, null, 2), 'utf8');
  }

  getThreadId(channelId: string): string | undefined {
    return this.maps.channelToThread[channelId];
  }

  getChannelId(threadId: string): string | undefined {
    return this.maps.threadToChannel[threadId];
  }

  bind(channelId: string, threadId: string): void {
    this.maps.channelToThread[channelId] = threadId;
    this.maps.threadToChannel[threadId] = channelId;
    this.save();
  }

  /** Bot 出站后调用，记录 discord message_id；下次 inbound 命中即丢弃（防回声） */
  rememberBotSent(discordMessageId: string): void {
    this.maps.recentBotSentMessageIds.push(discordMessageId);
    if (this.maps.recentBotSentMessageIds.length > RECENT_BOT_LIMIT) {
      this.maps.recentBotSentMessageIds.splice(
        0,
        this.maps.recentBotSentMessageIds.length - RECENT_BOT_LIMIT,
      );
    }
    this.save();
  }

  isBotEcho(discordMessageId: string): boolean {
    return this.maps.recentBotSentMessageIds.includes(discordMessageId);
  }
}
