import fs from 'node:fs';
import path from 'node:path';

import type { AutonomyTaskType } from './autonomy-types.js';

interface TaskStateRow {
  lastAt: string | null;
  day: string;
  count: number;
}

interface TaskStateFile {
  tasks: Record<string, TaskStateRow>;
}

function statePath(dataRoot: string): string {
  return path.join(dataRoot, 'autonomy', 'task-state.json');
}

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function loadState(dataRoot: string): TaskStateFile {
  const fp = statePath(dataRoot);
  if (!fs.existsSync(fp)) return { tasks: {} };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as TaskStateFile;
  } catch {
    return { tasks: {} };
  }
}

function saveState(dataRoot: string, state: TaskStateFile): void {
  const dir = path.join(dataRoot, 'autonomy');
  fs.mkdirSync(dir, { recursive: true });
  const fp = statePath(dataRoot);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

export function isTaskOnCooldown(
  dataRoot: string,
  taskType: AutonomyTaskType,
  cooldownMs: number,
  nowMs = Date.now(),
): boolean {
  if (cooldownMs <= 0) return false;
  const row = loadState(dataRoot).tasks[taskType];
  if (!row?.lastAt) return false;
  const last = Date.parse(row.lastAt);
  return Number.isFinite(last) && nowMs - last < cooldownMs;
}

export function isTaskOverDailyLimit(
  dataRoot: string,
  taskType: AutonomyTaskType,
  maxPerDay: number,
  now = new Date(),
): boolean {
  if (maxPerDay <= 0) return false;
  const row = loadState(dataRoot).tasks[taskType];
  if (!row) return false;
  return row.day === todayKey(now) && row.count >= maxPerDay;
}

export function recordTaskDispatch(dataRoot: string, taskType: AutonomyTaskType, now = new Date()): void {
  const state = loadState(dataRoot);
  const day = todayKey(now);
  const prev = state.tasks[taskType];
  const count = prev?.day === day ? prev.count + 1 : 1;
  state.tasks[taskType] = { lastAt: now.toISOString(), day, count };
  saveState(dataRoot, state);
}
