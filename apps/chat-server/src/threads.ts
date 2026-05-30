/**
 * ThreadStore —— 线程 + 消息持久化。
 *
 * - `threads.json`：所有线程元数据（大群 + DM）
 * - `messages/<thread_id>.json`：每个线程一个文件，消息数组按时间顺序
 *
 * 线程类型：
 * - 大群（group）：参与者列表为空数组（语义"全员"），任何已注册用户都可读写
 * - 私聊（dm）：thread_id = `dm:<a>:<b>`，participants = [a, b]
 *
 * 历史拉取使用 `before=<message_id>` cursor（在数组中找到该 id 的位置，取它之前的 `limit` 条）。
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type Message,
  type Thread,
  type Attachment,
  type MessagePart,
  type Mention,
  dmThreadId,
  isDmThreadId,
  parseDmThreadId,
} from '@utlra/webchat-protocol';
import { readJsonOr, writeJsonAtomic } from './store-io.js';

interface ThreadsFile {
  schema: 'threads.v1';
  threads: Thread[];
}

interface MessagesFile {
  schema: 'messages.v1';
  thread_id: string;
  messages: Message[];
}

const EMPTY_THREADS: ThreadsFile = { schema: 'threads.v1', threads: [] };

export interface ThreadStoreOptions {
  dataRoot: string;
  /** 默认大群 thread_id；首次启动会自动创建 */
  globalThreadId: string;
}

export interface CreateMessageInput {
  thread_id: string;
  sender_user_id: string;
  parts: MessagePart[];
  text: string;
  mentions: Mention[];
  attachments: Attachment[];
  reply_to_message_id?: string;
}

export class ThreadStore {
  private threadsById = new Map<string, Thread>();
  private messagesByThread = new Map<string, Message[]>();
  private readonly threadsFile: string;
  private readonly messagesDir: string;

  constructor(private readonly opts: ThreadStoreOptions) {
    this.threadsFile = path.join(opts.dataRoot, 'threads.json');
    this.messagesDir = path.join(opts.dataRoot, 'messages');
  }

  async init(): Promise<void> {
    const data = await readJsonOr<ThreadsFile>(this.threadsFile, EMPTY_THREADS);
    for (const t of data.threads ?? []) {
      this.threadsById.set(t.id, t);
    }
    if (!this.threadsById.has(this.opts.globalThreadId)) {
      const group: Thread = {
        id: this.opts.globalThreadId,
        kind: 'group',
        title: '大群',
        participants: [],
        created_at: new Date().toISOString(),
      };
      this.threadsById.set(group.id, group);
      await this.persistThreads();
    }
  }

  getGlobalThreadId(): string {
    return this.opts.globalThreadId;
  }

  get(threadId: string): Thread | undefined {
    return this.threadsById.get(threadId);
  }

  /** 当前用户可见线程：大群 + 自己参与的 DM。 */
  listVisible(userId: string): Thread[] {
    const out: Thread[] = [];
    for (const t of this.threadsById.values()) {
      if (t.kind === 'group') {
        out.push(t);
      } else if (t.kind === 'dm' && t.participants.includes(userId)) {
        out.push(t);
      }
    }
    return out;
  }

  /**
   * 获取或创建两人 DM 线程。
   *
   * @returns 已存在直接返回；不存在则创建并持久化。
   */
  async getOrCreateDm(userA: string, userB: string): Promise<Thread> {
    const id = dmThreadId(userA, userB);
    const existing = this.threadsById.get(id);
    if (existing) return existing;
    const pair = parseDmThreadId(id)!;
    const thread: Thread = {
      id,
      kind: 'dm',
      participants: [pair[0], pair[1]],
      created_at: new Date().toISOString(),
    };
    this.threadsById.set(id, thread);
    await this.persistThreads();
    return thread;
  }

  /**
   * 权限：是否允许 userId 读/写该线程。
   *
   * - 大群：所有已注册用户都允许
   * - DM：仅 participants 中两人
   */
  canAccess(threadId: string, userId: string): boolean {
    const t = this.threadsById.get(threadId);
    if (!t) return false;
    if (t.kind === 'group') return true;
    return t.participants.includes(userId);
  }

  /** 按 thread_id 列出参与者（用于 ChatIR 出站时的 participantSids 字段）。大群返回空数组。 */
  participantsOf(threadId: string): string[] {
    const t = this.threadsById.get(threadId);
    if (!t) return [];
    if (t.kind === 'group') return [];
    return [...t.participants];
  }

  async appendMessage(input: CreateMessageInput): Promise<Message> {
    const list = await this.loadMessages(input.thread_id);
    const message: Message = {
      id: randomUUID(),
      thread_id: input.thread_id,
      sender_user_id: input.sender_user_id,
      sent_at: new Date().toISOString(),
      text: input.text,
      parts: input.parts,
      ...(input.reply_to_message_id ? { reply_to_message_id: input.reply_to_message_id } : {}),
      mentions: input.mentions,
      attachments: input.attachments,
    };
    list.push(message);
    await this.persistMessages(input.thread_id, list);
    return message;
  }

  async findMessage(threadId: string, messageId: string): Promise<Message | undefined> {
    const list = await this.loadMessages(threadId);
    return list.find((m) => m.id === messageId);
  }

  /**
   * 历史分页。
   *
   * - `before` 是「上一页第一条」的 message_id。返回比它更早的 `limit` 条，按时间升序。
   * - `before` 缺失视为最新一页（取末尾 `limit` 条）。
   * - `next_before` 是再往前翻页时应当传入的值（= 当前返回页中第一条的 id）；
   *   没有更多消息时为 `null`。
   */
  /** 清空线程全部消息（保留线程元数据）。返回删除条数。 */
  async clearMessages(threadId: string): Promise<number> {
    const list = await this.loadMessages(threadId);
    const count = list.length;
    await this.persistMessages(threadId, []);
    return count;
  }

  async listMessages(
    threadId: string,
    before: string | undefined,
    limit: number,
  ): Promise<{ messages: Message[]; next_before: string | null }> {
    const list = await this.loadMessages(threadId);
    let endIdx = list.length;
    if (before) {
      const idx = list.findIndex((m) => m.id === before);
      if (idx >= 0) endIdx = idx;
    }
    const startIdx = Math.max(0, endIdx - limit);
    const page = list.slice(startIdx, endIdx);
    const next_before = startIdx > 0 && page.length > 0 ? page[0]!.id : null;
    return { messages: page, next_before };
  }

  private async loadMessages(threadId: string): Promise<Message[]> {
    const cached = this.messagesByThread.get(threadId);
    if (cached) return cached;
    const file = path.join(this.messagesDir, `${this.safeFile(threadId)}.json`);
    const data = await readJsonOr<MessagesFile>(file, {
      schema: 'messages.v1',
      thread_id: threadId,
      messages: [],
    });
    const list = data.messages ?? [];
    this.messagesByThread.set(threadId, list);
    return list;
  }

  private async persistMessages(threadId: string, list: Message[]): Promise<void> {
    this.messagesByThread.set(threadId, list);
    const file = path.join(this.messagesDir, `${this.safeFile(threadId)}.json`);
    const data: MessagesFile = {
      schema: 'messages.v1',
      thread_id: threadId,
      messages: list,
    };
    await writeJsonAtomic(file, data);
  }

  private async persistThreads(): Promise<void> {
    const data: ThreadsFile = {
      schema: 'threads.v1',
      threads: Array.from(this.threadsById.values()),
    };
    await writeJsonAtomic(this.threadsFile, data);
  }

  /** 把 thread_id 转成安全的文件名（替换 `:` 为 `__`），还原由 store 内部一致即可。 */
  private safeFile(threadId: string): string {
    return threadId.replaceAll(':', '__');
  }
}

export { isDmThreadId };
