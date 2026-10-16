/**
 * 工作台日志。上班时读一遍；交付时写下路径和一句话。
 * ADL: doc/structurizr/WORKSHOP.md §3 §5
 */
import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainRegistry } from './inner-brain-registry.js';

const LOG_NAME = 'bench-log.md';
const CLOCK_IN_NAME = 'clock-in-logs.md';

export function benchLogPath(workDir: string): string {
  return path.join(workDir, '.brain', LOG_NAME);
}

export function appendBenchLog(workDir: string, line: string): void {
  const file = benchLogPath(workDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = line.trim();
  if (!text) return;
  fs.appendFileSync(file, `${text}\n`, 'utf8');
}

/** 新工人上班：把其他台的日志抄一份到自己台上，只这一次。 */
export function writeClockInLogs(
  targetWorkDir: string,
  registry: InnerBrainRegistry,
  excludeWorkspaceId: string,
): { benches: number } {
  const chunks: string[] = [];
  for (const task of registry.list()) {
    if (task.workspaceId === excludeWorkspaceId) continue;
    const file = benchLogPath(task.workDir);
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, 'utf8').trim();
    if (!body) continue;
    chunks.push(`## ${task.workspaceId}\n\n${body}`);
  }
  const out = path.join(targetWorkDir, '.brain', CLOCK_IN_NAME);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    chunks.length > 0 ? `${chunks.join('\n\n')}\n` : '（其他工作台还没有日志）\n',
    'utf8',
  );
  return { benches: chunks.length };
}
