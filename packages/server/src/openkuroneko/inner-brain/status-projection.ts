/**
 * DyFlow → legacy inner-status.json 投影（供外脑 list_inner_brains / heartbeat 读取）。
 *
 * DyFlow 是唯一内脑引擎；`planning` / controller-state DECOMPOSE 已废弃。
 * setGoal 与 tick 期间把 dyflow-state.json 同步到 status.json。
 */
import fs from 'node:fs';
import path from 'node:path';

import { isDyflowWorkDir } from './dyflow-inspector.js';
import type { DyflowMode, DyflowState } from './types.js';
import type { InnerBrainStatus, InnerPhase } from '../../workspace-kit/inner-engine.js';
import type { WorkerStatus } from '../../pi-mono/inner-brain-worker.js';

const STATUS_REL = path.join('.run', 'status.json');

export interface DyflowStatusProjectionInput {
  workspaceId: string;
  workDir: string;
  tickCount: number;
  hadWork: boolean;
  /** 可选覆盖；默认读 dyflow-state.json */
  dyflowMode?: DyflowMode | string | null;
  note?: string;
}

export function mapDyflowModeToInnerPhase(mode: string | null | undefined): InnerPhase {
  switch (mode) {
    case 'DESIGN':
    case 'RUN':
    case 'ATTRIBUTE':
      return 'executing';
    case 'AWAITING':
      return 'paused';
    case 'DONE':
    case 'STOPPED':
      return 'idle';
    case 'ERROR':
      return 'paused';
    default:
      return 'executing';
  }
}

/** 外脑展示用：DyFlow 模式下返回 dyflow mode，legacy 返回 status.phase */
export function resolveOuterBrainPhase(workDir: string): {
  phase: string;
  engine: 'dyflow' | 'legacy' | null;
  dyflow_mode: string | null;
} {
  if (isDyflowWorkDir(workDir)) {
    const mode = readDyflowMode(workDir);
    return {
      phase: mode ? `dyflow:${mode}` : 'dyflow:DESIGN',
      engine: 'dyflow',
      dyflow_mode: mode,
    };
  }
  const st = readInnerStatusFile(workDir);
  const rawPhase = (st?.phase as string | undefined) ?? 'unknown';
  const phase = rawPhase === 'planning' ? 'executing' : rawPhase;
  return {
    phase,
    engine: st ? 'legacy' : null,
    dyflow_mode: null,
  };
}

/** setGoal 时 seed DyFlow FSM 初态（DESIGN），替代 legacy controller-state DECOMPOSE */
export function seedDyflowBurstState(workDir: string, burstId: string): void {
  const statePath = path.join(workDir, '.brain', 'dyflow-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const initial: DyflowState = {
    mode: 'DESIGN',
    burstId,
    designStreak: 0,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(initial, null, 2), 'utf8');
}

export function readDyflowMode(workDir: string): string | null {
  const statePath = path.join(workDir, '.brain', 'dyflow-state.json');
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { mode?: string };
    return typeof raw.mode === 'string' ? raw.mode : null;
  } catch {
    return null;
  }
}

function readInnerStatusFile(workDir: string): InnerBrainStatus | null {
  const p = path.join(workDir, STATUS_REL);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as InnerBrainStatus;
  } catch {
    return null;
  }
}

export function readWorkerTickProgress(workDir: string): {
  ticks: number;
  lastTickAt: string | null;
  workerPhase: string | null;
} {
  const p = path.join(workDir, '.run', 'inner-worker-status.json');
  if (!fs.existsSync(p)) {
    const st = readInnerStatusFile(workDir);
    return { ticks: st?.tickCount ?? 0, lastTickAt: null, workerPhase: null };
  }
  try {
    const w = JSON.parse(fs.readFileSync(p, 'utf8')) as WorkerStatus;
    return {
      ticks: w.ticks ?? 0,
      lastTickAt: w.lastTickAt ?? null,
      workerPhase: w.phase ?? null,
    };
  } catch {
    return { ticks: 0, lastTickAt: null, workerPhase: null };
  }
}

function readGoalSummary(workDir: string): string {
  for (const rel of ['.brain/goal.md', '.run/goal.md'] as const) {
    const p = path.join(workDir, rel);
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t.slice(0, 200);
    } catch {
      /* */
    }
  }
  return readInnerStatusFile(workDir)?.goalSummary ?? '';
}

/**
 * 将 DyFlow 运行时写入 status.json（外脑/ Dashboard 兼容层）。
 * 在 controller tick 开始/结束、以及 pi-mono auto 每轮后调用。
 */
export function projectDyflowStatus(input: DyflowStatusProjectionInput): InnerBrainStatus | null {
  if (!isDyflowWorkDir(input.workDir)) return null;

  const mode = input.dyflowMode ?? readDyflowMode(input.workDir);
  const phase = mapDyflowModeToInnerPhase(mode);
  const prev = readInnerStatusFile(input.workDir);
  const lastAction = [
    `dyflow:${mode ?? 'UNKNOWN'}`,
    `ticks=${input.tickCount}`,
    `hadWork=${input.hadWork}`,
    input.note,
  ]
    .filter(Boolean)
    .join(' ');

  const next: InnerBrainStatus = {
    schema: 'inner-status.v1',
    workspaceId: input.workspaceId,
    phase,
    goalSummary: readGoalSummary(input.workDir) || prev?.goalSummary || '',
    tickCount: Math.max(input.tickCount, prev?.tickCount ?? 0),
    lastAction,
    lastError: prev?.lastError ?? null,
    updatedAt: new Date().toISOString(),
    deliverables: prev?.deliverables ?? [],
  };

  const outPath = path.join(input.workDir, STATUS_REL);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(next, null, 2), 'utf8');
  touchWorkerLiveness(input.workDir, {
    ticks: next.tickCount,
    lastTickAt: next.updatedAt,
  });
  return next;
}

/** tick 进行中刷新 liveness（单轮 DESIGN/RUN 可能耗时很久，外脑靠 lastTickAt 判卡死） */
export function touchWorkerLiveness(
  workDir: string,
  opts: { ticks?: number; lastTickAt?: string },
): void {
  const p = path.join(workDir, '.run', 'inner-worker-status.json');
  let prev: Partial<WorkerStatus> = {};
  if (fs.existsSync(p)) {
    try {
      prev = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<WorkerStatus>;
    } catch {
      /* */
    }
  }
  const now = opts.lastTickAt ?? new Date().toISOString();
  const out: WorkerStatus = {
    phase: prev.phase === 'starting' ? 'running' : (prev.phase ?? 'running'),
    instanceId: prev.instanceId ?? '',
    workspaceId: prev.workspaceId ?? '',
    ticks: opts.ticks ?? prev.ticks ?? 0,
    lastTickAt: now,
    updatedAt: now,
    ...(prev.stoppedBy ? { stoppedBy: prev.stoppedBy } : {}),
    ...(prev.error ? { error: prev.error } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

/** pi-mono auto 结束时：用 dyflow 终态覆盖 status（替代读 legacy controller-state） */
export function projectDyflowStatusAfterAuto(
  workDir: string,
  workspaceId: string,
  pi: { ticks: number; lastHadWork: boolean; stoppedBy: string },
): InnerBrainStatus | null {
  if (!isDyflowWorkDir(workDir)) return null;
  const mode = readDyflowMode(workDir);
  return projectDyflowStatus({
    workspaceId,
    workDir,
    tickCount: pi.ticks,
    hadWork: pi.lastHadWork,
    dyflowMode: mode,
    note: `auto stoppedBy=${pi.stoppedBy}`,
  });
}
