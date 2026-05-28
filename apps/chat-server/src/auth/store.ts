/**
 * 白名单存储 —— 单一 JSON 文件，串行化写入。
 *
 * 与 `remote-console` 同思路，但裁掉 API token（chat-server 用 `WEBCHAT_AGENT_SECRET` 旁路）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { AuthData, Role, WhitelistEntry, WhitelistStatus } from './types.js';

const DEFAULT_DATA: AuthData = { whitelist: [] };

export class AuthStore {
  private data: AuthData = structuredClone(DEFAULT_DATA);
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const buf = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(buf) as Partial<AuthData>;
      this.data = {
        whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        await this.persist();
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, json, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  private enqueueWrite(): Promise<void> {
    const next = this.writeChain.then(() => this.persist());
    this.writeChain = next.catch(() => {});
    return next;
  }

  listWhitelist(): WhitelistEntry[] {
    return this.data.whitelist.map((e) => ({ ...e }));
  }

  getEntryByEmail(email: string): WhitelistEntry | undefined {
    const norm = AuthStore.normalizeEmail(email);
    return this.data.whitelist.find((e) => e.email === norm);
  }

  getEntryByUserId(userId: string): WhitelistEntry | undefined {
    return this.data.whitelist.find((e) => e.userId === userId);
  }

  async upsert(input: {
    email: string;
    role?: Role;
    status?: WhitelistStatus;
    addedBy: string;
    displayName?: string;
    userId?: string | null;
  }): Promise<WhitelistEntry> {
    const email = AuthStore.normalizeEmail(input.email);
    const now = Date.now();
    const existing = this.data.whitelist.find((e) => e.email === email);
    if (existing) {
      if (input.role !== undefined) existing.role = input.role;
      if (input.status !== undefined) existing.status = input.status;
      if (input.displayName !== undefined) existing.displayName = input.displayName;
      if (input.userId !== undefined) existing.userId = input.userId;
      existing.updatedAt = now;
      await this.enqueueWrite();
      return { ...existing };
    }
    const entry: WhitelistEntry = {
      email,
      displayName: input.displayName ?? email.split('@')[0]!,
      userId: input.userId ?? null,
      role: input.role ?? 'member',
      status: input.status ?? 'active',
      addedBy: input.addedBy,
      addedAt: now,
      updatedAt: now,
    };
    this.data.whitelist.push(entry);
    await this.enqueueWrite();
    return { ...entry };
  }

  async patch(
    email: string,
    patch: { role?: Role; status?: WhitelistStatus; displayName?: string; userId?: string | null },
  ): Promise<WhitelistEntry | null> {
    const norm = AuthStore.normalizeEmail(email);
    const entry = this.data.whitelist.find((e) => e.email === norm);
    if (!entry) return null;
    if (patch.role) entry.role = patch.role;
    if (patch.status) entry.status = patch.status;
    if (patch.displayName !== undefined) entry.displayName = patch.displayName;
    if (patch.userId !== undefined) entry.userId = patch.userId;
    entry.updatedAt = Date.now();
    await this.enqueueWrite();
    return { ...entry };
  }

  async remove(email: string): Promise<boolean> {
    const norm = AuthStore.normalizeEmail(email);
    const before = this.data.whitelist.length;
    this.data.whitelist = this.data.whitelist.filter((e) => e.email !== norm);
    if (this.data.whitelist.length === before) return false;
    await this.enqueueWrite();
    return true;
  }

  /** entry 存在且 status === 'active'。 */
  isAuthorized(email: string): boolean {
    const e = this.getEntryByEmail(email);
    return !!e && e.status === 'active';
  }
}
