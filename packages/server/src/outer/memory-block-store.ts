/**
 * Memory Block — local vault only (per DATA_ROOT / agent instance).
 * @see doc/structurizr/MEMORY-BLOCKS.md
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  getSystemBlocks,
  isSupportedCreateStrategy,
  isSystemBlockId,
  pathSafeBlockId,
  pathSafeKey,
  resolveStrategy,
  type BlockDefinition,
  type BlockStrategyId,
  type KvSecretEntry,
  type NotebookEntry,
} from './memory-block-strategies.js';

const VAULT_REL = 'vault/blocks';
const INDEX_FILE = 'blocks-index.json';

interface BlocksIndexFile {
  schema: 'memory-blocks.v1';
  blocks: BlockDefinition[];
}

export interface MemoryBlockStoreOptions {
  dataRoot: string;
  agentId?: string;
}

export class MemoryBlockStore {
  private readonly dataRoot: string;
  private readonly agentId: string;
  private userBlocks: BlockDefinition[];

  constructor(opts: MemoryBlockStoreOptions) {
    this.dataRoot = opts.dataRoot;
    this.agentId = opts.agentId ?? 'default';
    this.userBlocks = loadUserBlocks(opts.dataRoot);
    fs.mkdirSync(this.vaultRoot(), { recursive: true });
  }

  listBlocks(): BlockDefinition[] {
    return this.mergedBlocks().map((b) => ({ ...b }));
  }

  resolveBlock(blockId: string): BlockDefinition {
    const id = pathSafeBlockId(blockId);
    const block = this.mergedBlocks().find((b) => b.blockId === id);
    if (!block) throw new Error(`memory_block: unknown block_id ${id}`);
    return block;
  }

  async createBlock(
    blockId: string,
    strategy: BlockStrategyId,
    opts: { title?: string; description?: string },
    _createdBy?: string,
  ): Promise<BlockDefinition> {
    const id = pathSafeBlockId(blockId);
    if (!isSupportedCreateStrategy(strategy)) {
      throw new Error(`memory_block: cannot create block with strategy ${strategy}`);
    }
    if (isSystemBlockId(id) || this.mergedBlocks().some((b) => b.blockId === id)) {
      throw new Error(`memory_block: block_id already exists: ${id}`);
    }
    const now = new Date().toISOString();
    const block: BlockDefinition = {
      blockId: id,
      strategy,
      title: opts.title?.trim() || id,
      description: opts.description?.trim() || `Memory block (${strategy})`,
      created_at: now,
      updated_at: now,
      system: false,
    };
    this.userBlocks.push(block);
    this.persistUserBlocks();
    fs.mkdirSync(this.entryDir(id), { recursive: true });
    return { ...block };
  }

  async updateBlock(
    blockId: string,
    patch: { title?: string; description?: string },
  ): Promise<BlockDefinition> {
    const id = pathSafeBlockId(blockId);
    if (isSystemBlockId(id)) {
      throw new Error(`memory_block: cannot update system block ${id}`);
    }
    const idx = this.userBlocks.findIndex((b) => b.blockId === id);
    if (idx < 0) throw new Error(`memory_block: unknown block_id ${id}`);
    const cur = this.userBlocks[idx]!;
    if (patch.title !== undefined) cur.title = patch.title.trim() || cur.blockId;
    if (patch.description !== undefined) cur.description = patch.description.trim();
    cur.updated_at = new Date().toISOString();
    this.persistUserBlocks();
    return { ...cur };
  }

  async deleteBlock(blockId: string): Promise<boolean> {
    const id = pathSafeBlockId(blockId);
    if (isSystemBlockId(id)) {
      throw new Error(`memory_block: cannot delete system block ${id}`);
    }
    const idx = this.userBlocks.findIndex((b) => b.blockId === id);
    if (idx < 0) return false;
    this.userBlocks.splice(idx, 1);
    this.persistUserBlocks();
    const dir = this.entryDir(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return true;
  }

  async listEntryKeys(blockId: string): Promise<string[]> {
    const block = this.resolveBlock(blockId);
    const dir = this.entryDir(block.blockId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
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
    const raw = this.readEntryJson(block.blockId, key);
    if (!raw) return null;
    const entry = coerceEntryForStrategy(raw, block.strategy);
    const redactSecrets =
      (block.strategy === 'kv_secret' || block.blockId === 'keychain') &&
      !(opts.includeValue ?? false);
    return strategy.toPublicMeta(entry as KvSecretEntry & NotebookEntry, redactSecrets);
  }

  async put(
    blockId: string,
    key: string,
    payload: Record<string, unknown>,
    updatedBy?: string,
  ): Promise<Record<string, unknown>> {
    const block = this.resolveBlock(blockId);
    const strategy = resolveStrategy(block.strategy);
    const safeKey = pathSafeKey(key);
    const entry = strategy.normalizePut(safeKey, payload, updatedBy ?? this.agentId);
    this.writeEntryJson(block.blockId, safeKey, entry);
    return strategy.toPublicMeta(entry, false);
  }

  async deleteEntry(blockId: string, key: string): Promise<boolean> {
    const block = this.resolveBlock(blockId);
    pathSafeKey(key);
    const local = this.entryPath(block.blockId, key);
    if (!fs.existsSync(local)) return false;
    fs.unlinkSync(local);
    return true;
  }

  /** @deprecated use deleteEntry */
  async delete(blockId: string, key: string): Promise<boolean> {
    return this.deleteEntry(blockId, key);
  }

  private mergedBlocks(): BlockDefinition[] {
    const byId = new Map<string, BlockDefinition>();
    for (const b of getSystemBlocks()) byId.set(b.blockId, b);
    for (const b of this.userBlocks) byId.set(b.blockId, { ...b });
    return Array.from(byId.values());
  }

  private indexPath(): string {
    return path.join(this.vaultRoot(), INDEX_FILE);
  }

  private persistUserBlocks(): void {
    const file: BlocksIndexFile = {
      schema: 'memory-blocks.v1',
      blocks: this.userBlocks,
    };
    fs.mkdirSync(this.vaultRoot(), { recursive: true });
    fs.writeFileSync(this.indexPath(), JSON.stringify(file, null, 2), 'utf8');
  }

  private vaultRoot(): string {
    return path.join(this.dataRoot, VAULT_REL);
  }

  private entryDir(blockId: string): string {
    return path.join(this.vaultRoot(), blockId, 'entries');
  }

  private entryPath(blockId: string, key: string): string {
    return path.join(this.entryDir(blockId), `${pathSafeKey(key)}.json`);
  }

  private readEntryJson(blockId: string, key: string): unknown | null {
    const fp = this.entryPath(blockId, key);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as unknown;
  }

  private writeEntryJson(blockId: string, key: string, entry: unknown): void {
    const dest = this.entryPath(blockId, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(entry, null, 2), 'utf8');
  }
}

function loadUserBlocks(dataRoot: string): BlockDefinition[] {
  const fp = path.join(dataRoot, VAULT_REL, INDEX_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as BlocksIndexFile;
    if (raw.schema !== 'memory-blocks.v1' || !Array.isArray(raw.blocks)) return [];
    return raw.blocks.filter(
      (b) =>
        b &&
        typeof b.blockId === 'string' &&
        !isSystemBlockId(b.blockId) &&
        isSupportedCreateStrategy(b.strategy),
    );
  } catch {
    return [];
  }
}

export function createMemoryBlockStore(dataRoot: string, agentId?: string): MemoryBlockStore {
  return new MemoryBlockStore({ dataRoot, agentId });
}

/** Legacy kv_secret JSON on disk → notebook shape for keychain migration */
function coerceEntryForStrategy(raw: unknown, strategyId: BlockStrategyId): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (strategyId !== 'notebook') return raw;
  if (typeof r.body === 'string') return raw;
  if (typeof r.value !== 'string') return raw;
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === 'string')
    : typeof r.kind === 'string'
      ? [r.kind]
      : [];
  return {
    key: typeof r.key === 'string' ? r.key : '',
    title: typeof r.title === 'string' ? r.title : typeof r.key === 'string' ? r.key : '',
    body: r.value,
    tags,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
    updated_by: typeof r.updated_by === 'string' ? r.updated_by : '',
  } satisfies NotebookEntry;
}
