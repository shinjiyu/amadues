/**
 * toolIndex — 内循环词汇表（ADL: TOOL-MDL-GROWTH.md M2）
 *
 * 元层不是一个动作：内核有一条**固定约定**——工具索引 = `tools/` 目录的函数。
 * 写文件是对象层的普通 shell 动作；让它变成可调用词汇的，是这里。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  manifestCostTokens,
  parseToolManifest,
  type ManifestValidateOptions,
  type ToolManifest,
} from './tool-manifest.js';

export interface ToolIndexEntry {
  name: string;
  description: string;
  args: ToolManifest['args'];
  costTokens: number;
}

export interface ToolIndex {
  entries: ToolIndexEntry[];
  /** 每轮都付的文法代价合计 */
  grammarCostTokens: number;
  /** manifest 不合法而被跳过的目录名 */
  skipped: string[];
}

export function buildToolIndex(workDir: string, opts: ManifestValidateOptions = {}): ToolIndex {
  const dir = path.join(workDir, 'tools');
  if (!fs.existsSync(dir)) return { entries: [], grammarCostTokens: 0, skipped: [] };

  const entries: ToolIndexEntry[] = [];
  const skipped: string[] = [];

  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const file = path.join(dir, ent.name, 'manifest.json');
    if (!fs.existsSync(file)) {
      skipped.push(ent.name);
      continue;
    }
    const m = parseToolManifest(fs.readFileSync(file, 'utf8'), opts);
    if (!m) {
      skipped.push(ent.name);
      continue;
    }
    entries.push({
      name: m.name,
      description: m.description,
      args: m.args,
      costTokens: manifestCostTokens(m),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    entries,
    grammarCostTokens: entries.reduce((sum, e) => sum + e.costTokens, 0),
    skipped: skipped.sort(),
  };
}

/** 渲染进 prompt 的词汇表。只出名字/参数/描述——不出函数体、不出路径（M1） */
export function renderToolIndex(index: ToolIndex): string {
  if (index.entries.length === 0) return '(no learned tools yet)';
  return index.entries
    .map(e => {
      const args = Object.entries(e.args ?? {})
        .map(([k, v]) => (v.required ? `${k}: ${v.type}` : `${k}?: ${v.type}`))
        .join(', ');
      return `- ${e.name}(${args}): ${e.description}`;
    })
    .join('\n');
}
