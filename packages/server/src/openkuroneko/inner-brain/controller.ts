/**
 * DyFlow 内脑控制器 — 新 FSM：DESIGN → RUN → AWAITING → DONE。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §3
 *
 * 暴露与 legacy controller 相同的 tick() 契约，供 run-tick 按
 * INNER_BRAIN_ENGINE flag 切换。状态持久化在 .brain/dyflow-state.json。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { createLocalNodeStore } from './local-node-store.js';
import type { LocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import type { MemoryStore } from './memory-store.js';
import { seedPresetNodes } from './preset-seeder.js';
import { runDesigner } from './designer.js';
import { applyFailureDistill, distillRunFailures } from './failure-distill.js';
import { maybeEmitBurstStallAlert } from './burst-stall-alert.js';
import { runLocalDag } from './runner.js';
import type { RunnerResult } from './runner.js';
import { readLocalDag, clearLocalDag } from './local-dag-store.js';
import { listActivePendings } from '../pendings/index.js';
import type { NodeDefDrive9Store } from '../../drive9/node-def-drive9-store.js';
import type { EnvSnapshot } from './node-abstractor.js';
import type { DagHistoryEntry, DyflowState, LocalDag } from './types.js';

/** DESIGN 连续空转上限：超过则判定无法推进，进入 DONE（reason 标记） */
const MAX_EMPTY_DESIGN_STREAK = 3;

export interface DyflowControllerContext {
  workDir: string;
  burstId: string;
  /** 如 `ib-mpxjtjll-d566`；用于空转告警路径与索引 */
  instanceId?: string;
  /** registry.startedAt ISO；长时空转判定 */
  burstStartedAt?: string | null;
}

/** P1：节点共享（drive9）配置；提供后 Designer 有 search_and_instance，creator 自动导出 */
export interface NodeSharingConfig {
  defStore: NodeDefDrive9Store;
  sourceAgent: string;
  env?: EnvSnapshot;
}

export interface DyflowControllerDeps {
  llm: LLMAdapter;
  /** baseNode 可用的全套工具 */
  toolRegistry: ToolRegistry;
  logger: Logger;
  store?: LocalNodeStore;
  memory?: MemoryStore;
  /** DONE 时回调（用于发 COMPLETE 通知） */
  onComplete?: (reason: string) => void | Promise<void>;
  /** P1：节点共享 */
  nodeSharing?: NodeSharingConfig;
}

export interface DyflowTickResult {
  hadWork: boolean;
}

export interface DyflowController {
  tick(): Promise<DyflowTickResult>;
}

export function createDyflowController(
  ctx: DyflowControllerContext,
  deps: DyflowControllerDeps,
): DyflowController {
  const { workDir, burstId, instanceId, burstStartedAt } = ctx;
  const { llm, toolRegistry, logger, onComplete } = deps;

  function burstStartedAtMs(): number | null {
    if (!burstStartedAt) return null;
    const t = new Date(burstStartedAt).getTime();
    return Number.isFinite(t) ? t : null;
  }

  function checkStallAndAlert(trigger: string): void {
    const id =
      instanceId ??
      (burstId.startsWith('task-') ? burstId.replace(/^task-/, 'ib-') : burstId);
    maybeEmitBurstStallAlert({
      workDir,
      instanceId: id,
      trigger,
      memory,
      logger,
      dyflowStatePath: statePath,
      startedAtMs: burstStartedAtMs(),
    });
  }
  const store = deps.store ?? createLocalNodeStore(workDir);
  const memory = deps.memory ?? createMemoryStore(workDir);
  const statePath = path.join(workDir, '.brain', 'dyflow-state.json');

  // P1：从 nodeSharing 派生 designer.sharing（含 sourceAgent，供 promote_local_node 自动导出 drive9）
  const sharing = deps.nodeSharing
    ? {
        defStore: deps.nodeSharing.defStore,
        sourceAgent: deps.nodeSharing.sourceAgent,
        llm,
        logger,
        ...(deps.nodeSharing.env ? { env: deps.nodeSharing.env } : {}),
      }
    : undefined;

  // 首次 spawn：注入 preset/*（幂等）
  seedPresetNodes(workDir, { store });
  // 从 legacy goal.md 兜底 seed memory.goal（外脑 set_goal 仍写 goal.md）
  seedGoalIntoMemory(workDir, memory);

  function readState(): DyflowState {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw) as DyflowState;
      if (parsed && parsed.mode) return parsed;
    } catch { /* fallthrough */ }
    return { mode: 'DESIGN', burstId, designStreak: 0, updatedAt: new Date().toISOString() };
  }

  function writeState(next: Partial<DyflowState> & { mode: DyflowState['mode'] }): DyflowState {
    const state: DyflowState = {
      burstId,
      designStreak: 0,
      ...next,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    return state;
  }

  return {
    async tick(): Promise<DyflowTickResult> {
      const state = readState();
      logger.info('dyflow-controller', { event: 'tick.start', data: { mode: state.mode, burstId } });

      switch (state.mode) {
        case 'DESIGN': {
          const outcome = await runDesigner({ llm, logger, store, memory, workDir, burstId, ...(sharing ? { sharing } : {}) });
          if (outcome.kind === 'run') {
            writeState({ mode: 'RUN', designStreak: 0 });
            return { hadWork: true };
          }
          if (outcome.kind === 'done') {
            writeState({ mode: 'DONE', reason: outcome.reason, designStreak: 0 });
            clearLocalDag(workDir);
            await onComplete?.(outcome.reason);
            return { hadWork: true };
          }
          // empty：Designer 没出图也没完成
          const streak = (state.designStreak ?? 0) + 1;
          if (streak >= 2) {
            checkStallAndAlert(`design.empty_streak:${streak}`);
          }
          if (streak >= MAX_EMPTY_DESIGN_STREAK) {
            const reason = `Designer 连续 ${streak} 次空转，无法推进：${outcome.reason}`;
            writeState({ mode: 'DONE', reason, designStreak: streak });
            await onComplete?.(reason);
            logger.warn('dyflow-controller', { event: 'design.giveup', data: { burstId, streak } });
            checkStallAndAlert(`design.giveup:${streak}`);
            return { hadWork: true };
          }
          writeState({ mode: 'DESIGN', designStreak: streak });
          return { hadWork: true };
        }

        case 'RUN': {
          const dag = readLocalDag(workDir);
          if (!dag) {
            writeState({ mode: 'DESIGN', designStreak: 0 });
            return { hadWork: true };
          }
          const res = await runLocalDag(dag, { llm, toolRegistry, store, memory, logger, workDir });
          clearLocalDag(workDir);
          archiveDagHistory(memory, dag, res);
          if (!res.ok) {
            const distilled = distillRunFailures({
              results: res.results,
              lastFailure: memory.read().last_failure,
            });
            const added = applyFailureDistill(memory, distilled);
            logger.info('dyflow-controller', {
              event: 'failure.distill',
              data: { burstId, failedAt: res.failedAt, distilled: distilled.length, added },
            });
            checkStallAndAlert(`failure.distill:${res.failedAt ?? 'unknown'}`);
          }
          const brainDir = path.join(workDir, '.brain');
          const activePendings = fs.existsSync(path.join(brainDir, 'pendings.json'))
            ? listActivePendings(brainDir)
            : [];
          if (activePendings.length > 0) {
            writeState({
              mode: 'AWAITING',
              designStreak: 0,
              reason: res.ok ? null : `RUN failed at ${res.failedAt}`,
            });
            return { hadWork: false };
          }
          // 无 pending：回 DESIGN 继续规划
          writeState({ mode: 'DESIGN', designStreak: 0, reason: res.ok ? null : `RUN failed at ${res.failedAt}` });
          return { hadWork: true };
        }

        case 'AWAITING':
          return { hadWork: false };

        case 'DONE':
        case 'ERROR':
        case 'STOPPED':
          return { hadWork: false };

        default:
          logger.error('dyflow-controller', { event: 'unknown.mode', data: { mode: state.mode } });
          return { hadWork: false };
      }
    },
  };
}

/** RUN 后把 committed DAG + 执行结果归档进 memory.dag_history（§6.8） */
function archiveDagHistory(memory: MemoryStore, dag: LocalDag, res: RunnerResult): void {
  const byId = new Map(res.results.map(r => [r.nodeInstId, r]));
  const nodes: DagHistoryEntry['nodes'] = dag.nodes.map(inst => {
    const r = byId.get(inst.id);
    const status: DagHistoryEntry['nodes'][number]['status'] = r
      ? (r.status ?? (r.ok ? 'ok' : 'failed'))
      : 'pending';
    return {
      id: inst.id,
      ref: inst.ref,
      ...(inst.instruction ? { instruction: inst.instruction.slice(0, 200) } : {}),
      status,
      ...(inst.deliverable?.summary ? { deliverable: inst.deliverable.summary } : {}),
    };
  });
  const entry: DagHistoryEntry = {
    burstId: dag.burstId,
    designedAt: dag.designedAt,
    finishedAt: new Date().toISOString(),
    ok: res.ok,
    ...(res.failedAt ? { failedAt: res.failedAt } : {}),
    nodes,
    ...(dag.notes ? { notes: dag.notes } : {}),
  };
  try {
    memory.appendDagHistory(entry);
  } catch { /* 归档失败不阻断主流程 */ }
}

function seedGoalIntoMemory(workDir: string, memory: MemoryStore): void {
  if (memory.read().goal) return;
  try {
    const goalPath = path.join(workDir, '.brain', 'goal.md');
    const goal = fs.readFileSync(goalPath, 'utf8').trim();
    if (goal) memory.patch('goal', goal);
  } catch { /* no goal.md yet */ }
}
