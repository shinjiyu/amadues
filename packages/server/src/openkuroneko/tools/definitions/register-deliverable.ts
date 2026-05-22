/**
 * register_deliverable — 登记本任务要回传给外脑的产物（协议：doc/protocols/inner-brain-deliverables.md）
 *
 * 执行过程中可多次调用，将需要随 COMPLETE 一并下发的文件路径加入列表。
 * 路径相对于工作目录，外脑收到 COMPLETE 后按 workDir + 路径读取并发送给用户。
 */

import fs from 'node:fs';
import path from 'node:path';

import { getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';

const DELIVERABLES_FILENAME = 'deliverables.json';

let _deliverablesPath: string | null = null;

/** CLI 启动时注入 tempDir，产物列表写入 <tempDir>/deliverables.json */
export function setDeliverablesTempDir(tempDir: string): void {
  _deliverablesPath = path.join(tempDir, DELIVERABLES_FILENAME);
}

function ensureDeliverablesPath(): string {
  if (!_deliverablesPath) throw new Error('deliverables tempDir not set');
  return _deliverablesPath;
}

export const registerDeliverableTool: Tool = {
  name: 'register_deliverable',
  description:
    '将当前任务的一个产出文件登记为「待回传给用户」的产物。任务全部完成时，外脑会把这些文件一并发给任务发起人。\n\n' +
    'relative_path：相对于工作目录的路径，如 "报告.md"、"output/chart.png"。可多次调用以登记多个文件。',
  parameters: {
    relative_path: {
      type: 'string',
      description: '相对于工作目录的文件路径',
    },
  },
  required: ['relative_path'],
  async call(args) {
    const raw = String(args['relative_path'] ?? '').trim();
    if (!raw) return { ok: false, output: '缺少参数: relative_path' };

    const workDir = getWorkDir();
    const normalized = path.normalize(raw).replace(/\\/g, '/');
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { ok: false, output: 'relative_path 不能为绝对路径或包含 ..' };
    }

    const absPath = path.join(workDir, normalized);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return { ok: false, output: `文件不存在或不是普通文件：${normalized}` };
    }

    const fp = ensureDeliverablesPath();
    let list: string[] = [];
    try {
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf8');
        const parsed = JSON.parse(content);
        list = Array.isArray(parsed) ? parsed.filter((x: unknown) => typeof x === 'string') : [];
      }
    } catch { /* start fresh */ }

    if (!list.includes(normalized)) list.push(normalized);
    fs.writeFileSync(fp, JSON.stringify(list), 'utf8');

    return { ok: true, output: `已登记产物：${normalized}（共 ${list.length} 项）` };
  },
};
