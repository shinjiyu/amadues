/**
 * Preset Seeder — 首次 spawn 注入 preset/* LocalNode。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §10 / INNER-NODE-LIFECYCLE.md §8
 *
 * 幂等：已存在且版本相同则跳过；版本更新（worker 包升级）则覆盖。
 * preset 不参与 drive9 export（metadata.export=false）。
 */

import type { LocalNodeStore } from './local-node-store.js';
import { createLocalNodeStore } from './local-node-store.js';
import { PRESET_NODES } from './preset-nodes.js';
import type { LocalNode } from './types.js';

export interface SeedResult {
  seeded: string[];
  upgraded: string[];
  skipped: string[];
}

export function seedPresetNodes(
  workDir: string,
  opts?: { store?: LocalNodeStore; presets?: readonly LocalNode[] },
): SeedResult {
  const store = opts?.store ?? createLocalNodeStore(workDir);
  const presets = opts?.presets ?? PRESET_NODES;
  const result: SeedResult = { seeded: [], upgraded: [], skipped: [] };

  for (const node of presets) {
    const existing = store.read(node.id);
    if (!existing) {
      store.commit(node);
      result.seeded.push(node.id);
    } else if (existing.version !== node.version) {
      store.commit(node);
      result.upgraded.push(node.id);
    } else {
      result.skipped.push(node.id);
    }
  }

  return result;
}
