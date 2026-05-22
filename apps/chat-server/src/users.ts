/**
 * UserStore —— 用户表 + 在线状态。
 *
 * 持久化：`users.json`（仅 user_id、display_name、created_at）。
 * 在线状态：纯内存 Map<user_id, count>（多 socket 计数；归零即离线）。
 *
 * 没有认证，所以 user_id 是「客户端自报」；首次见到即写入。display_name 可以被
 * 同名 user_id 后续连接覆盖（最新一次声称生效）。
 */
import path from 'node:path';
import type { User, UserPresence } from '@utlra/webchat-protocol';
import { readJsonOr, writeJsonAtomic } from './store-io.js';

interface UsersFile {
  schema: 'users.v1';
  users: User[];
}

const EMPTY: UsersFile = { schema: 'users.v1', users: [] };

export interface UserStoreOptions {
  dataRoot: string;
}

export class UserStore {
  private byId = new Map<string, User>();
  private onlineCount = new Map<string, number>();
  private readonly file: string;

  constructor(private readonly opts: UserStoreOptions) {
    this.file = path.join(opts.dataRoot, 'users.json');
  }

  async init(): Promise<void> {
    const data = await readJsonOr<UsersFile>(this.file, EMPTY);
    for (const u of data.users ?? []) {
      this.byId.set(u.user_id, u);
    }
  }

  /**
   * Upsert：首次见到 user_id 即创建；后续连接更新 display_name。
   *
   * 返回最终的 User 记录。该调用会异步落盘（不等待），调用者可继续；并发写在
   * `writeJsonAtomic` 层串行化（rename 原子）。
   */
  async upsert(userId: string, displayName: string): Promise<User> {
    const existing = this.byId.get(userId);
    const now = new Date().toISOString();
    const user: User = existing
      ? { ...existing, display_name: displayName }
      : { user_id: userId, display_name: displayName, created_at: now };
    this.byId.set(userId, user);
    await this.persist();
    return user;
  }

  get(userId: string): User | undefined {
    return this.byId.get(userId);
  }

  list(): User[] {
    return Array.from(this.byId.values());
  }

  listWithPresence(): UserPresence[] {
    return this.list().map((u) => ({
      ...u,
      online: this.isOnline(u.user_id),
    }));
  }

  isOnline(userId: string): boolean {
    return (this.onlineCount.get(userId) ?? 0) > 0;
  }

  /** 增加在线计数；返回新状态（true = 上线，false = 已在线累加） */
  markOnline(userId: string): boolean {
    const prev = this.onlineCount.get(userId) ?? 0;
    this.onlineCount.set(userId, prev + 1);
    return prev === 0;
  }

  /** 减少在线计数；返回新状态（true = 真正离线，false = 还有其它 socket） */
  markOffline(userId: string): boolean {
    const prev = this.onlineCount.get(userId) ?? 0;
    if (prev <= 1) {
      this.onlineCount.delete(userId);
      return true;
    }
    this.onlineCount.set(userId, prev - 1);
    return false;
  }

  private async persist(): Promise<void> {
    const data: UsersFile = { schema: 'users.v1', users: this.list() };
    await writeJsonAtomic(this.file, data);
  }
}
