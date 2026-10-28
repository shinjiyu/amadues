/**
 * 内脑异步状态快照 — 供外脑 read_inner_status / list_inner_brains / onExit 判定使用。
 *
 * DyFlow 引擎读 `.brain/dyflow-state.json`（DESIGN/RUN/ATTRIBUTE/AWAITING/…）；
 * legacy pi-mono 读 `.brain/controller-state.json`（DECOMPOSE/AWAITING/…）。
 * ADL: doc/structurizr/KPI-MANAGER-LAYER.md §6
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  listActivePendings,
  type PendingItem,
} from '../openkuroneko/pendings/index.js';
import { isDyflowWorkDir } from '../openkuroneko/inner-brain/dyflow-inspector.js';
import type { DyflowMode } from '../openkuroneko/inner-brain/types.js';
import { formatAgentIsoLocal } from '../agent-time.js';

/** 与 controller.handleAllCompleted 一致 */
export const POST_COMPLETE_REASON = '目标已完成，等待新目标';

export interface ControllerStateSlice {
  mode: string | null;
  awaiting_reason: string | null;
  blocked_reason: string | null;
  cycle_count: number | null;
}

export interface PendingSummary {
  id: string;
  kind: string;
  status: string;
  source: string | null;
  execute_at: string | null;
  prompt_preview: string | null;
  intent_expectation: string | null;
}

export interface BrainAsyncSnapshot {
  controller: ControllerStateSlice;
  active_pendings: PendingSummary[];
  /** 最近一条 pending timer 的 execute_at（若有） */
  next_wake_at: string | null;
  /** 内脑在等定时 / 信号 / 真人（不含「里程碑已完成」假挂起） */
  is_async_waiting: boolean;
  /** 里程碑已全部完成；registry 应视为 DONE，勿再 set_goal「第 N 轮」 */
  is_post_complete: boolean;
  /** 有 ask_user pending — ongoing KPI 槽位仍占（KPI-ADVANCEMENT.md §5） */
  has_ask_user_pending: boolean;
}

function brainDirFor(workDir: string): string {
  return path.join(workDir, '.brain');
}

function readDyflowStateSlice(workDir: string): ControllerStateSlice | null {
  const statePath = path.join(brainDirFor(workDir), 'dyflow-state.json');
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const mode = typeof raw['mode'] === 'string' ? raw['mode'] : null;
    const reason = typeof raw['reason'] === 'string' ? raw['reason'] : null;
    return {
      mode,
      awaiting_reason: mode === 'AWAITING' ? reason : null,
      blocked_reason: mode === 'ERROR' ? reason : null,
      cycle_count: null,
    };
  } catch {
    return null;
  }
}

export function readControllerStateSlice(workDir: string): ControllerStateSlice {
  const empty: ControllerStateSlice = {
    mode: null,
    awaiting_reason: null,
    blocked_reason: null,
    cycle_count: null,
  };

  if (isDyflowWorkDir(workDir)) {
    return readDyflowStateSlice(workDir) ?? empty;
  }

  const statePath = path.join(brainDirFor(workDir), 'controller-state.json');
  if (!fs.existsSync(statePath)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    return {
      mode: typeof raw['mode'] === 'string' ? raw['mode'] : null,
      awaiting_reason: typeof raw['awaitingReason'] === 'string' ? raw['awaitingReason'] : null,
      blocked_reason: typeof raw['blockedReason'] === 'string' ? raw['blockedReason'] : null,
      cycle_count: typeof raw['cycleCount'] === 'number' ? raw['cycleCount'] : null,
    };
  } catch {
    return empty;
  }
}

/** DyFlow burst 是否在等异步（timer / ask_user / FSM AWAITING） */
function isDyflowAsyncWaiting(mode: DyflowMode | null, hasNonCompletePending: boolean): boolean {
  if (mode === 'AWAITING') return true;
  if (mode === 'DONE' || mode === 'ERROR' || mode === 'STOPPED') return false;
  return hasNonCompletePending;
}

function summarizePending(p: PendingItem): PendingSummary {
  const spec = p.spec as unknown as Record<string, unknown>;
  let execute_at: string | null = null;
  let prompt_preview: string | null = null;
  if (p.kind === 'timer' && typeof spec['execute_at'] === 'string') {
    execute_at = spec['execute_at'];
  }
  if (p.kind === 'ask_user' && typeof spec['prompt'] === 'string') {
    prompt_preview = spec['prompt'].slice(0, 160);
  }
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    source: p.source ?? null,
    execute_at,
    prompt_preview,
    intent_expectation: p.intent?.expectation ?? null,
  };
}

export function buildBrainAsyncSnapshot(workDir: string): BrainAsyncSnapshot {
  const controller = readControllerStateSlice(workDir);
  const dir = brainDirFor(workDir);
  const active = fs.existsSync(path.join(dir, 'pendings.json'))
    ? listActivePendings(dir)
    : [];
  const active_pendings = active.map(summarizePending);

  const timerTimes = active_pendings
    .filter((p) => p.kind === 'timer' && p.execute_at)
    .map((p) => p.execute_at!)
    .sort();
  const next_wake_at = timerTimes[0] ?? null;

  const is_post_complete =
    controller.awaiting_reason === POST_COMPLETE_REASON ||
    controller.blocked_reason === POST_COMPLETE_REASON ||
    active_pendings.some((p) => p.source === 'all-complete');

  const has_ask_user_pending = active_pendings.some(
    (p) => p.kind === 'ask_user' && p.status === 'pending',
  );

  const hasNonCompletePending = active_pendings.some((p) => p.source !== 'all-complete');
  const dyflowMode = isDyflowWorkDir(workDir) ? (controller.mode as DyflowMode | null) : null;
  const is_async_waiting =
    !is_post_complete &&
    (dyflowMode != null
      ? isDyflowAsyncWaiting(dyflowMode, hasNonCompletePending)
      : controller.mode === 'AWAITING' || hasNonCompletePending);

  return {
    controller,
    active_pendings,
    next_wake_at,
    is_async_waiting,
    is_post_complete,
    has_ask_user_pending,
  };
}

/** KPI 推进槽位：ask_user 仍占槽 */
export function hasAskUserPending(workDir: string): boolean {
  return buildBrainAsyncSnapshot(workDir).has_ask_user_pending;
}

/** burst 退出后是否应标 AWAITING（与 ChangeWatcher 续跑语义一致） */
export function isBrainAwaitingAsync(workDir: string): boolean {
  return buildBrainAsyncSnapshot(workDir).is_async_waiting;
}

/** 将 async 快照中的 ISO 时刻转为 agent 本地时间，供 LLM 工具 JSON 输出 */
export function formatBrainAsyncSnapshotForLlm(snap: BrainAsyncSnapshot): BrainAsyncSnapshot {
  return {
    ...snap,
    next_wake_at: snap.next_wake_at ? formatAgentIsoLocal(snap.next_wake_at) : null,
    active_pendings: snap.active_pendings.map((p) => ({
      ...p,
      execute_at: p.execute_at ? formatAgentIsoLocal(p.execute_at) : null,
    })),
  };
}

/** 写入外脑 system prompt。派活见 WORKSHOP.md。 */
export const OUTER_ASYNC_ORCHESTRATION_GUIDE = `
## 派工与等待（必读）
- 现在能做的一件事：\`set_goal\`。做完就结束。
- 到点再做：\`schedule_commitment\`。工具：\`list_calendar\` / \`cancel_commitment\` / \`pause_commitment\` / \`resume_commitment\`。
- **禁止**对用户说「系统没有日历 / 没有 cron」。
- 看进度：\`read_inner_status\` / \`list_inner_brains\`。
  - \`has_ask_user_pending=true\`：人还没回，勿再派一个人。
  - 健康 RUNNING、日程未到：不要重复派发。
  - \`wait_timer\` 只用于这一件任务里的短等待。下一件业务时间点用 \`schedule_commitment\`。
`.trim();
