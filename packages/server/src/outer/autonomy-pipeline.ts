/**
 * 心跳 tick：environment → kpiManager → casual chat dispatch。
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
import { evaluateAutonomyVerdict } from './environment/autonomy-judge.js';
import { loadAutonomyPolicy } from './environment/autonomy-policy-store.js';
import { dispatchCasualChat, type CasualChatDispatchDeps } from './casual-chat-dispatcher.js';
import { isKpiSprintInProgress } from './kpi-dispatch-guard.js';
import type { AutonomyDispatchResult, ResourceSnapshot } from './autonomy-types.js';
import { resolveAgentSid, resolveWorkspaceId, type OuterToolContext } from './outer-tools.js';
import { tickKpiManager } from './kpi/kpi-manager.js';
import { resolveAwaitingReviewLlmCaller } from './kpi/kpi-awaiting-review-llm.js';

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
  loadThreads?: () => LooseThreadStore;
  identityRegistry?: IdentityRegistry;
  /** Disable legacy heartbeat KPI advance when digitalEmployeeLoop is wired. */
  digitalEmployeeMode?: boolean;
}

export interface AutonomyPipelineResult {
  snapshot: ResourceSnapshot;
  kpiManager: {
    dispatched: boolean;
    reason: string;
    reapedCount: number;
    detail?: string;
  };
  dispatch: AutonomyDispatchResult;
  skippedLegacyHeartbeat: boolean;
}

export async function runAutonomyPipeline(deps: AutonomyPipelineDeps): Promise<AutonomyPipelineResult> {
  const agentSid = deps.agentSid ?? resolveAgentSid();
  const workspaceId = deps.workspaceId ?? resolveWorkspaceId();
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
  };

  const kpiResult = await tickKpiManager(
    {
      dataRoot: deps.dataRoot,
      registry: deps.registry,
      kpiRegistry: deps.kpiRegistry,
      toolCtx,
      workspaceId,
      defaultThreadId: deps.defaultThreadId,
      awaitingReviewLlm:
        verdict.level === 'idle' ? resolveAwaitingReviewLlmCaller(deps.getLlmEnv) : undefined,
      allowAdvance: !deps.digitalEmployeeMode,
    },
    envSnapshot,
    verdict,
  );

  if (kpiResult.awaitingReview.stopped.length > 0) {
    console.log(
      `[utlra][kpi-manager] awaiting_review stopped=${kpiResult.awaitingReview.stopped.join(',')}`,
    );
  }
  if (kpiResult.reaped.abortedIds.length > 0) {
    console.log(
      `[utlra][kpi-manager] reaped=${kpiResult.reaped.abortedIds.join(',')} ` +
      `skipped=${kpiResult.reaped.skippedPending.join(',')}`,
    );
  }
  if (kpiResult.failureCircuit.tripped.length > 0) {
    console.log(
      `[utlra][kpi-manager] failure_circuit paused=` +
      kpiResult.failureCircuit.tripped.map((t) => `${t.kpiId}(${t.failures})`).join(','),
    );
  }
  if (kpiResult.workflowCircuit.paused.length > 0) {
    console.log(
      `[utlra][kpi-manager] workflow_circuit paused=` +
        kpiResult.workflowCircuit.paused
          .map((t) => `${t.routeKey}(${t.failures})`)
          .join(','),
    );
  }
  if (kpiResult.dispatched) {
    console.log(
      `[utlra][kpi-manager] dispatched kpi=${kpiResult.kpiId ?? '-'} ` +
      `instance=${kpiResult.instanceId ?? '-'} reason=${kpiResult.reason}`,
    );
  } else if (verdict.level === 'idle' && deps.kpiRegistry.list({ status: 'active' }).length > 0) {
    console.log(`[utlra][kpi-manager] no dispatch: ${kpiResult.reason}`);
  }

  const dispatchDeps: CasualChatDispatchDeps = {
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
  };

  const dispatch = await dispatchCasualChat(dispatchDeps, snapshot, verdict);

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
  } else if (!kpiResult.dispatched) {
    console.log(`[utlra][autonomy] idle no dispatch: ${dispatch.reason}`);
  }

  const kpiSprintHold = isKpiSprintInProgress(deps.registry, deps.kpiRegistry);

  return {
    snapshot,
    kpiManager: {
      dispatched: kpiResult.dispatched,
      reason: kpiResult.reason,
      reapedCount: kpiResult.reaped.abortedIds.length,
      detail: kpiResult.detail,
    },
    dispatch,
    skippedLegacyHeartbeat: kpiResult.dispatched || dispatch.dispatched || kpiSprintHold,
  };
}
