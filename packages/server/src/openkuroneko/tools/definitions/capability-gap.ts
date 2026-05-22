/**
 * capability_gap_handler — 能力缺口元规则
 *
 * 本轮仅标记缺口，写入 <tempDir>/capability-gaps.jsonl；
 * 下一轮通过 web_search + write_file 自举（Agent 自行决策）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../index.js';

export interface CapabilityGapRecord {
  ts: string;
  gap: string;
  reason: string;
  status: 'pending' | 'resolved';
  resolved_at?: string;
  resolution?: string;
}

let _tempDir: string | null = null;
const GAP_FILENAME = 'capability-gaps.jsonl';

/** CLI 启动时注入 tempDir */
export function setCapabilityGapTempDir(tempDir: string): void {
  _tempDir = tempDir;
}

function normalizeGapKey(gap: string): string {
  return gap.trim().toLowerCase().replace(/\s+/g, ' ');
}

function readAllGaps(tempDir: string): CapabilityGapRecord[] {
  const gapFile = path.join(tempDir, GAP_FILENAME);
  if (!fs.existsSync(gapFile)) return [];
  return fs
    .readFileSync(gapFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CapabilityGapRecord);
}

function writeAllGaps(tempDir: string, records: CapabilityGapRecord[]): void {
  const gapFile = path.join(tempDir, GAP_FILENAME);
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(gapFile, body ? `${body}\n` : '', 'utf8');
}

export function recordGap(tempDir: string, gap: string, reason: string): {
  recorded: boolean;
  existing?: CapabilityGapRecord;
} {
  const records = readAllGaps(tempDir);
  const normalized = normalizeGapKey(gap);
  const existing = records.find(
    (record) => record.status === 'pending' && normalizeGapKey(record.gap) === normalized,
  );
  if (existing) {
    return { recorded: false, existing };
  }

  const record: CapabilityGapRecord = {
    ts: new Date().toISOString(),
    gap: gap.trim(),
    reason: reason.trim(),
    status: 'pending',
  };
  records.push(record);
  writeAllGaps(tempDir, records);
  return { recorded: true };
}

export const capabilityGapTool: Tool = {
  name: 'capability_gap_handler',
  description:
    'Manage capability gaps for self-bootstrapping. ' +
    'action: record | resolve | list (default: record). ' +
    'gap: the missing capability to record or resolve. ' +
    'reason: why it is needed. ' +
    'resolution: what was changed to close the gap.',
  parameters: {
    action: {
      type: 'string',
      description: 'record | resolve | list，默认 record',
      enum: ['record', 'resolve', 'list'],
    },
    gap: {
      type: 'string',
      description: '能力缺口描述；record / resolve 时必填',
    },
    reason: {
      type: 'string',
      description: '为什么需要补这个能力；record 时可选',
    },
    resolution: {
      type: 'string',
      description: '如何修复了该能力缺口；resolve 时可选',
    },
  },

  async call(args): Promise<{ ok: boolean; output: string }> {
    const action = String(args['action'] ?? 'record').trim().toLowerCase();
    const gap    = String(args['gap'] ?? '').trim();
    const reason = String(args['reason'] ?? '').trim();
    const resolution = String(args['resolution'] ?? '').trim();

    if (action === 'list') {
      if (!_tempDir) return { ok: true, output: 'No pending capability gaps (tempDir not configured).' };
      const pending = readPendingGaps(_tempDir);
      if (pending.length === 0) return { ok: true, output: 'No pending capability gaps.' };
      const lines = pending.map(
        (record, index) =>
          `${index + 1}. ${record.gap}` +
          (record.reason ? ` — ${record.reason}` : '') +
          ` (since ${record.ts})`,
      );
      return { ok: true, output: `Pending capability gaps (${pending.length}):\n${lines.join('\n')}` };
    }

    if (!gap) return { ok: false, output: 'Missing required argument: gap' };

    if (action === 'resolve') {
      if (!_tempDir) return { ok: false, output: 'capability gap tempDir not set' };
      const changed = resolveGap(_tempDir, gap, resolution);
      if (!changed) {
        return { ok: false, output: `No pending capability gap matched: "${gap}"` };
      }
      return {
        ok: true,
        output: resolution
          ? `Capability gap resolved: "${gap}". Resolution: ${resolution}`
          : `Capability gap resolved: "${gap}".`,
      };
    }

    if (action !== 'record') {
      return { ok: false, output: `Unsupported action: ${action}` };
    }

    // Persist to disk if tempDir is available
    if (!_tempDir) {
      return {
        ok: true,
        output: `Capability gap noted but tempDir not set: "${gap}".`,
      };
    }

    try {
      const recorded = recordGap(_tempDir, gap, reason);
      if (!recorded.recorded) {
        return {
          ok: true,
          output: `Capability gap already pending: "${recorded.existing?.gap ?? gap}". Avoid duplicate recording.`,
        };
      }
    } catch (e) {
      return { ok: false, output: `Failed to write gap record: ${String(e)}` };
    }

    return {
      ok: true,
      output:
        `Capability gap recorded: "${gap}". ` +
        `Next loop round: use web_search to find a solution, then write_file / shell_exec to self-bootstrap.`,
    };
  },
};

/** 读取所有未解决的缺口（供 Runner R 阶段检索） */
export function readPendingGaps(tempDir: string): CapabilityGapRecord[] {
  return readAllGaps(tempDir).filter((r) => r.status === 'pending');
}

/** 将某条缺口标记为已解决 */
export function resolveGap(tempDir: string, gap: string, resolution = ''): boolean {
  const records = readAllGaps(tempDir);
  const normalized = normalizeGapKey(gap);
  let changed = false;
  const updated = records.map((record) => {
    if (record.status !== 'pending' || normalizeGapKey(record.gap) !== normalized) {
      return record;
    }
    changed = true;
    return {
      ...record,
      status: 'resolved' as const,
      resolved_at: new Date().toISOString(),
      resolution: resolution || undefined,
    };
  });
  if (!changed) return false;
  writeAllGaps(tempDir, updated);
  return true;
}
