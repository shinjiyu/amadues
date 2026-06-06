/**
 * 心跳 tick：resourceProbe → hard gates → autonomy dispatch。
 */
import type { ChatIRChannel } from '@utlra/chat-ir';
import type { ChatAssetStore } from '@utlra/chat-ir';
import type { IdentityRegistry, LooseThreadStore } from '@utlra/chat-ir';
import type { FilesystemRepositoryStore, FilesystemWorkspaceStore, InnerBrainEngine } from '../workspace-kit/index.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import type { OuterMemoryStore } from './outer-memory.js';
import type { KpiRegistry } from './kpi-registry.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { ResourceProbeDeps } from './resource-probe.js';
import {
  collectEnvironmentSnapshot,
  getSharedEnvironment,
  toResourceSnapshot,
} from './environment/index.js';
import { runLiveStrategyPhase } from './strategy/live-adapter.js';
import { evaluateAutonomyVerdict } from './autonomy-judge.js';
import { loadAutonomyPolicy } from './autonomy-policy-store.js';
import { dispatchAutonomyTasks, type AutonomyDispatchDeps } from './autonomy-task-dispatcher.js';
import { isKpiSprintInProgress } from './kpi-dispatch-guard.js';
import type { AutonomyDispatchResult, ResourceSnapshot } from './autonomy-types.js';
import { resolveAgentSid, resolveWorkspaceId, type OuterToolContext } from './outer-tools.js';

export interface AutonomyPipelineDeps {
  dataRoot: string;
  repoRoot?: string;
  agentSid?: string;
  workspaceId?: string;
  defaultThreadId: string;
  registry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  imClient: ChatIRChannel | null;
  assetStore: ChatAssetStore;
  getEngine: (workspaceId: string) => InnerBrainEngine;
  workspaceStore: FilesystemWorkspaceStore;
  repoStore: FilesystemRepositoryStore;
  memoryStore?: OuterMemoryStore;
  getLlmEnv: () => InnerLlmEnv | null;
  getOrchestratorStats?: ResourceProbeDeps['getOrchestratorStats'];
  scheduleReflexionBurst?: (kpiId: string) => string | null;
  scheduleNextKpiBurst?: (kpiId: string, excludeInstanceId?: string) => string | null;
  loadThreads?: () => LooseThreadStore;
  identityRegistry?: IdentityRegistry;
}

export interface AutonomyPipelineResult {
  snapshot: ResourceSnapshot;
  dispatch: AutonomyDispatchResult;
  skippedLegacyHeartbeat: boolean;
}

export async function runAutonomyPipeline(deps: AutonomyPipelineDeps): Promise<AutonomyPipelineResult> {
  const agentSid = deps.agentSid ?? resolveAgentSid();
  const workspaceId = deps.workspaceId ?? resolveWorkspaceId();
  // 环境模型：采集 EnvironmentSnapshot（留存 current.json/events + 派生量），
  // 再适配回 ResourceSnapshot 喂给现有 judge/dispatch（P0→P1 facade，行为等价）。
  const env = getSharedEnvironment(deps.dataRoot);
  const { snapshot: envSnapshot } = collectEnvironmentSnapshot(
    {
      agentId: agentSid,
      registry: deps.registry,
      defaultThreadId: deps.defaultThreadId,
      getOrchestratorStats: deps.getOrchestratorStats,
    },
    env.registry,
    env.journal,
  );
  const snapshot = toResourceSnapshot(envSnapshot);
  const policy = loadAutonomyPolicy(deps.dataRoot);
  const verdict = evaluateAutonomyVerdict(snapshot, policy);

  // 战略层：idle 时在 dispatch 前跑 plan + reap，并把 focusOrder 交给 dispatcher
  // （dispatcher 不再自由选 KPI，改读 strategy.focusOrder）。
  let strategyFocusOrder: string[] | undefined;
  let strategyMode = false;
  if (verdict.level === 'idle') {
    strategyMode = true;
    const rawEvents = env.journal.recentUnconsumedEvents(20);
    try {
      const phase = await runLiveStrategyPhase({
        dataRoot: deps.dataRoot,
        agentId: agentSid,
        kpiRegistry: deps.kpiRegistry,
        registry: deps.registry,
        envEvents: rawEvents.map((e) => ({ sensorId: e.sensorId, field: e.field, note: e.note, kind: e.kind })),
        snapshot,
        maxRunningInnerBrains: policy.hardGates.maxRunningInnerBrains,
        getLlmEnv: deps.getLlmEnv,
      });
      strategyFocusOrder = phase.strategy?.focusOrder;
      if (phase.reevaluated && rawEvents.length > 0) env.journal.markEventsConsumed(rawEvents);
      console.log(
        `[utlra][strategy] reeval=${phase.reevaluated} triggers=${phase.triggers.join(',')} ` +
        `rejected=${phase.planRejected} aborted=${phase.abortedIds.length} focus=${(strategyFocusOrder ?? []).join('>')}`,
      );
    } catch (e) {
      console.log(`[utlra][strategy] phase error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const toolCtx: OuterToolContext = {
    threadId: deps.defaultThreadId.trim(),
    agentSid,
    workspaceId,
    repoRoot: deps.repoRoot,
    imClient: deps.imClient as never,
    assetStore: deps.assetStore,
    getEngine: deps.getEngine,
    workspaceStore: deps.workspaceStore,
    repoStore: deps.repoStore,
    dataRoot: deps.dataRoot,
    memoryStore: deps.memoryStore,
    innerBrainRegistry: deps.registry,
    kpiRegistry: deps.kpiRegistry,
    scheduleReflexionBurst: deps.scheduleReflexionBurst,
    scheduleNextKpiBurst: deps.scheduleNextKpiBurst,
  };

  const dispatchDeps: AutonomyDispatchDeps = {
    dataRoot: deps.dataRoot,
    agentSid,
    workspaceId,
    defaultThreadId: deps.defaultThreadId,
    registry: deps.registry,
    kpiRegistry: deps.kpiRegistry,
    imClient: deps.imClient,
    toolCtx,
    getLlmEnv: deps.getLlmEnv,
    getEngine: deps.getEngine,
    memoryStore: deps.memoryStore,
    loadThreads: deps.loadThreads,
    identityRegistry: deps.identityRegistry,
    ...(strategyFocusOrder ? { focusOrder: strategyFocusOrder } : {}),
    strategyMode,
  };

  const dispatch = await dispatchAutonomyTasks(dispatchDeps, snapshot, verdict);

  if (verdict.level === 'busy') {
    console.log(
      `[utlra][autonomy] busy gate=${verdict.blockedByHardGate ?? 'unknown'} ` +
      `running=${snapshot.innerBrains.running} llm=${snapshot.llm.inFlight}`,
    );
  } else if (dispatch.dispatched) {
    console.log(
      `[utlra][autonomy] dispatched task=${dispatch.taskType} reason=${dispatch.reason} ` +
      `${dispatch.detail ? `detail=${dispatch.detail.slice(0, 80)}` : ''}`,
    );
  } else {
    console.log(`[utlra][autonomy] idle no dispatch: ${dispatch.reason}`);
  }

  const kpiSprintHold = isKpiSprintInProgress(deps.registry, deps.kpiRegistry);

  return {
    snapshot,
    dispatch,
    skippedLegacyHeartbeat: dispatch.dispatched || kpiSprintHold,
  };
}
