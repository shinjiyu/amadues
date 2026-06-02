/**
 * LocalNode Store — .brain/local_nodes/ 读写 + index 维护
 *
 * ADL：doc/structurizr/INNER-NODE-LIFECYCLE.md §2 / §8
 *
 * 存储布局（id 直接映射子路径）：
 *   .brain/local_nodes/preset/base.json
 *   .brain/local_nodes/local/ps_open_battle.json
 *   .brain/local_nodes/imported/<defId>@<ver>.json
 *   .brain/local_nodes/index.json
 *
 * burst 全保留：本 store 不做清理，跨 burst 复用由外脑 cull 控制。
 */

import fs from 'node:fs';
import path from 'node:path';

import type {
  LocalNode,
  LocalNodeIndex,
  LocalNodeIndexEntry,
} from './types.js';

export interface LocalNodeStore {
  /** 写入 / 覆盖一个 LocalNode（校验 + 维护 index + 触发 updatedAt） */
  commit(node: LocalNode): LocalNode;
  read(id: string): LocalNode | null;
  has(id: string): boolean;
  /** 返回 index 条目（轻量摘要，供 Designer 选用） */
  list(): LocalNodeIndexEntry[];
  remove(id: string): void;
  readIndex(): LocalNodeIndex;
  /** 扫描目录重建 index（修复增量漂移） */
  rebuildIndex(): LocalNodeIndex;
  /** 节点库根目录（绝对路径） */
  readonly rootDir: string;
}

const ID_PATTERN = /^[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-]+)*$/;

function assertValidId(id: string): void {
  if (!id || !ID_PATTERN.test(id) || id.includes('..')) {
    throw new Error(`[local-node-store] invalid LocalNode id: ${JSON.stringify(id)}`);
  }
}

function validateNode(node: LocalNode): void {
  assertValidId(node.id);
  if (!node.version) throw new Error(`[local-node-store] node ${node.id} missing version`);
  if (!node.body || !node.body.kind) {
    throw new Error(`[local-node-store] node ${node.id} missing body.kind`);
  }
  if (node.body.kind === 'executor') {
    if (!Array.isArray(node.body.tools) || node.body.tools.length === 0) {
      throw new Error(`[local-node-store] executor node ${node.id} must declare non-empty tools allowlist`);
    }
    if (typeof node.body.promptTemplate !== 'string' || node.body.promptTemplate.trim() === '') {
      throw new Error(`[local-node-store] executor node ${node.id} must have promptTemplate`);
    }
  } else if (node.body.kind === 'graph') {
    if (!Array.isArray(node.body.nodes) || node.body.nodes.length === 0) {
      throw new Error(`[local-node-store] graph node ${node.id} must have non-empty nodes[]`);
    }
  }
  if (!node.interface || !Array.isArray(node.interface.outputs)) {
    throw new Error(`[local-node-store] node ${node.id} missing interface.outputs`);
  }
}

function toIndexEntry(node: LocalNode): LocalNodeIndexEntry {
  return {
    id: node.id,
    version: node.version,
    displayName: node.displayName,
    description: node.description,
    tags: node.tags ?? [],
    origin: node.metadata.origin,
    kind: node.body.kind,
    updatedAt: node.metadata.updatedAt,
  };
}

export function createLocalNodeStore(workDir: string): LocalNodeStore {
  const rootDir = path.join(workDir, '.brain', 'local_nodes');
  const indexPath = path.join(rootDir, 'index.json');

  function nodePath(id: string): string {
    assertValidId(id);
    return path.join(rootDir, `${id}.json`);
  }

  function readIndex(): LocalNodeIndex {
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as LocalNodeIndex;
      if (parsed && Array.isArray(parsed.entries)) return parsed;
    } catch { /* fallthrough */ }
    return { entries: [], updatedAt: new Date(0).toISOString() };
  }

  function writeIndex(index: LocalNodeIndex): void {
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  function upsertIndexEntry(node: LocalNode): void {
    const index = readIndex();
    const entry = toIndexEntry(node);
    const i = index.entries.findIndex(e => e.id === node.id);
    if (i >= 0) index.entries[i] = entry;
    else index.entries.push(entry);
    index.updatedAt = new Date().toISOString();
    writeIndex(index);
  }

  function removeIndexEntry(id: string): void {
    const index = readIndex();
    const next = index.entries.filter(e => e.id !== id);
    if (next.length !== index.entries.length) {
      index.entries = next;
      index.updatedAt = new Date().toISOString();
      writeIndex(index);
    }
  }

  return {
    rootDir,

    commit(node: LocalNode): LocalNode {
      validateNode(node);
      const now = new Date().toISOString();
      const persisted: LocalNode = {
        ...node,
        metadata: {
          ...node.metadata,
          createdAt: node.metadata.createdAt || now,
          updatedAt: now,
        },
      };
      const fp = nodePath(persisted.id);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(persisted, null, 2), 'utf8');
      upsertIndexEntry(persisted);
      return persisted;
    },

    read(id: string): LocalNode | null {
      try {
        const raw = fs.readFileSync(nodePath(id), 'utf8');
        return JSON.parse(raw) as LocalNode;
      } catch {
        return null;
      }
    },

    has(id: string): boolean {
      try {
        return fs.existsSync(nodePath(id));
      } catch {
        return false;
      }
    },

    list(): LocalNodeIndexEntry[] {
      return readIndex().entries;
    },

    remove(id: string): void {
      try {
        fs.unlinkSync(nodePath(id));
      } catch { /* ignore missing */ }
      removeIndexEntry(id);
    },

    readIndex,

    rebuildIndex(): LocalNodeIndex {
      const entries: LocalNodeIndexEntry[] = [];
      const walk = (dir: string): void => {
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
          const full = path.join(dir, name);
          let stat: fs.Stats;
          try { stat = fs.statSync(full); } catch { continue; }
          if (stat.isDirectory()) { walk(full); continue; }
          if (!name.endsWith('.json') || full === indexPath) continue;
          try {
            const node = JSON.parse(fs.readFileSync(full, 'utf8')) as LocalNode;
            if (node && node.id && node.metadata) entries.push(toIndexEntry(node));
          } catch { /* skip malformed */ }
        }
      };
      walk(rootDir);
      const index: LocalNodeIndex = { entries, updatedAt: new Date().toISOString() };
      writeIndex(index);
      return index;
    },
  };
}
