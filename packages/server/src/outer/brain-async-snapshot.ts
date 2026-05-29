/**
 * 内脑异步状态快照 — 供外脑 read_inner_status / list_inner_brains / onExit 判定使用。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  listActivePendings,
  type PendingItem,
} from '../openkuroneko/pendings/index.js';
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
}

function brainDirFor(workDir: string): string {
  return path.join(workDir, '.brain');
}

export function readControllerStateSlice(workDir: string): ControllerStateSlice {
  const empty: ControllerStateSlice = {
    mode: null,
    awaiting_reason: null,
    blocked_reason: null,
    cycle_count: null,
  };
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

  const is_async_waiting =
    !is_post_complete &&
    (controller.mode === 'AWAITING' ||
      active_pendings.some((p) => p.source !== 'all-complete'));

  return {
    controller,
    active_pendings,
    next_wake_at,
    is_async_waiting,
    is_post_complete,
  };
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

/** 写入外脑 system prompt（对话 + 心跳共用） */
export const OUTER_ASYNC_ORCHESTRATION_GUIDE = `
## 内脑异步 / 定时（必读）
- **持续监督、周期检查、等回复、等 SSE/限速**：只 **set_goal 一次**（可挂 kpi_id），在 goal 里写清周期与检查项；由内脑在执行中调用 **wait_timer**（或里程碑带 [cyclic:N]），到点后 **ChangeWatcher 自动在同一 instance/workDir 续跑**。
- **禁止**为同一 KPI 再 set_goal「第 2/3 轮监督检查」——那会新建 instance，破坏工作区连续性。
- burst 结束后先用 **read_inner_status** / **list_inner_brains** 看 \`async.is_async_waiting\`、\`next_wake_at\`、\`active_pendings\`：
  - \`is_async_waiting=true\`：内脑在等定时/信号/真人，**不要**再 set_goal；需要催进度用 **send_directive**（AWAITING 实例可用）。
  - \`is_post_complete=true\`：里程碑已全部完成，registry 应为 DONE；向用户汇报结果即可，**不要**再派同主题新 burst。
- KPI 多手段探索：仍用 set_kpi + **首次** set_goal；后续优先等内脑 timer / 反思 burst，只有明确换路线时才再 set_goal（新尝试，非「第 N 轮」措辞）。
`.trim();
