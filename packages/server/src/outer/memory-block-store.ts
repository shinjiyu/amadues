/**
 * @see doc/structurizr/MEMORY-BLOCKS.md
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Drive9Client } from '../drive9/drive9-client.js';
import {
  getDefaultBlockRegistry,
  pathSafeKey,
  resolveStrategy,
  type BlockDefinition,
  type BlockStrategyId,
  type KvSecretEntry,
} from './memory-block-strategies.js';

const VAULT_REL = 'vault/blocks';

export interface MemoryBlockStoreOptions {
  dataRoot: string;
  drive9?: Drive9Client | null;
  agentId?: string;
  blocks?: BlockDefinition[];
}

export class MemoryBlockStore {
  private readonly dataRoot: string;
  private readonly drive9: Drive9Client | null;
  private readonly agentId: string;
  private readonly blocks: BlockDefinition[];

  constructor(opts: MemoryBlockStoreOptions) {
    this.dataRoot = opts.dataRoot;
    this.drive9 = opts.drive9 ?? null;
    this.agentId = opts.agentId ?? 'default';
    this.blocks = opts.blocks ?? getDefaultBlockRegistry();
  }

  listBlocks(): BlockDefinition[] {
    return this.blocks.map((b) => ({ ...b }));
  }

  resolveBlock(blockId: string): BlockDefinition {
    const block = this.blocks.find((b) => b.blockId === blockId);
    if (!block) throw new Error(`memory_block: unknown block_id ${blockId}`);
    return block;
  }

  async listEntryKeys(blockId: string): Promise<string[]> {
    const block = this.resolveBlock(blockId);
    if (this.drive9) {
      const dir = this.drive9EntryDir(blockId);
      const entries = await this.drive9.list(dir);
      return entries
        .filter((e) => e.name.endsWith('.json'))
        .map((e) => e.name.replace(/\.json$/, ''));
    }
    const localDir = this.localEntryDir(blockId);
    if (!fs.existsSync(localDir)) return [];
    return fs
      .readdirSync(localDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  async get(
    blockId: string,
    key: string,
    opts: { includeValue?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    const block = this.resolveBlock(blockId);
    const strategy = resolveStrategy(block.strategy);
    const raw = await this.readEntryJson(blockId, key);
    if (!raw) return null;
    const redact = block.strategy === 'kv_secret' && !opts.includeValue;
    return strategy.toPublicMeta(raw as KvSecretEntry, redact);
  }

  async put(
    blockId: string,
    key: string,
    payload: Record<string, unknown>,
    updatedBy?: string,
  ): Promise<Record<string, unknown>> {
    const block = this.resolveBlock(blockId);
    const strategy = resolveStrategy(block.strategy);
    pathSafeKey(key);
    const entry = strategy.normalizePut(key, payload, updatedBy ?? this.agentId);
    await this.writeEntryJson(blockId, key, entry);
    const redact = block.strategy === 'kv_secret';
    return strategy.toPublicMeta(entry, redact);
  }

  async delete(blockId: string, key: string): Promise<boolean> {
    this.resolveBlock(blockId);
    pathSafeKey(key);
    if (this.drive9) {
      const p = this.drive9EntryPath(blockId, key);
      try {
        await this.drive9.delete(p);
        return true;
      } catch {
        return false;
      }
    }
    const local = this.localEntryPath(blockId, key);
    if (!fs.existsSync(local)) return false;
    fs.unlinkSync(local);
    return true;
  }

  /**
   * Write selected keys into workDir/.brain/secrets/ for inner brain read_file.
   */
  async bind(blockId: string, keys: string[], workDir: string): Promise<string[]> {
    const block = this.resolveBlock(blockId);
    const strategy = resolveStrategy(block.strategy);
    const secretsDir = path.join(workDir, '.brain', 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    const written: string[] = [];
    for (const key of keys) {
      pathSafeKey(key);
      const raw = await this.readEntryJson(blockId, key);
      if (!raw) throw new Error(`memory_block: missing entry ${blockId}/${key}`);
      const rel = strategy.bindRelativePath(key);
      const dest = path.join(secretsDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(raw, null, 2), 'utf8');
      written.push(path.join('.brain/secrets', rel).replace(/\\/g, '/'));
    }
    return written;
  }

  // ── storage ─────────────────────────────────────────────────────────────

  private localVaultRoot(): string {
    return path.join(this.dataRoot, VAULT_REL);
  }

  private localEntryDir(blockId: string): string {
    return path.join(this.localVaultRoot(), blockId, 'entries');
  }

  private localEntryPath(blockId: string, key: string): string {
    return path.join(this.localEntryDir(blockId), `${pathSafeKey(key)}.json`);
  }

  private drive9EntryDir(blockId: string): string {
    return `/${VAULT_REL}/${blockId}/entries`;
  }

  private drive9EntryPath(blockId: string, key: string): string {
    return `${this.drive9EntryDir(blockId)}/${pathSafeKey(key)}.json`;
  }

  private async readEntryJson(blockId: string, key: string): Promise<unknown | null> {
    if (this.drive9) {
      const p = this.drive9EntryPath(blockId, key);
      try {
        const text = await this.drive9.read(p);
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    }
    const local = this.localEntryPath(blockId, key);
    if (!fs.existsSync(local)) return null;
    return JSON.parse(fs.readFileSync(local, 'utf8')) as unknown;
  }

  private async writeEntryJson(blockId: string, key: string, entry: unknown): Promise<void> {
    const body = JSON.stringify(entry, null, 2);
    if (this.drive9) {
      await this.drive9.write(this.drive9EntryPath(blockId, key), body);
      return;
    }
    const dest = this.localEntryPath(blockId, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
  }
}

export function createMemoryBlockStore(dataRoot: string, drive9?: Drive9Client | null, agentId?: string): MemoryBlockStore {
  return new MemoryBlockStore({ dataRoot, drive9: drive9 ?? null, agentId });
}
