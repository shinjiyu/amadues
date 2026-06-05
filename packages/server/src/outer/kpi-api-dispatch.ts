/**
 * Ops / E2E：HTTP 直连 `set_goal(kpi_id)`，绕过外脑 LLM。
 *
 * ADL：doc/structurizr/KPI-CLOSED-LOOP.md §API dispatch
 */
import type { ChatAssetStore, ChatIRChannel } from '@utlra/chat-ir';
import type {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';
import type { SkillDrive9Store } from '../drive9/skill-drive9-store.js';
import type { KnowledgeDrive9Store } from '../drive9/knowledge-drive9-store.js';
import type { SkillMemoryStore } from '../mem9/skill-memory-store.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { KpiRegistry } from './kpi-registry.js';
import { isSetGoalDispatched } from './inner-brain-kpi-reuse.js';
import { evaluateKpiAutonomyDispatch } from './kpi-dispatch-guard.js';
import {
  executeOuterTool,
  resolveAgentSid,
  resolveWorkspaceId,
  type OuterToolContext,
} from './outer-tools.js';
import type { OuterMemoryStore } from './outer-memory.js';

export interface KpiApiDispatchDeps {
  dataRoot: string;
  repoRoot: string;
  innerBrainRegistry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  assetStore: ChatAssetStore;
  getEngine: (workspaceId: string) => InnerBrainEngine;
  workspaceStore: FilesystemWorkspaceStore;
  repoStore: FilesystemRepositoryStore;
  imClient?: ChatIRChannel | null;
  memoryStore?: OuterMemoryStore | null;
  skillStore?: SkillMemoryStore;
  skillDrive9Store?: SkillDrive9Store;
  knowledgeDrive9Store?: KnowledgeDrive9Store;
  scheduleReflexionBurst?: (kpiId: string) => string | null;
  scheduleNextKpiBurst?: (kpiId: string, excludeInstanceId?: string) => string | null;
  defaultThreadId?: string;
  agentSid?: string;
  workspaceId?: string;
}

export interface KpiApiDispatchInput {
  goal?: string;
  origin_thread?: string;
  origin_user?: string;
}

export interface KpiApiDispatchResult {
  ok: boolean;
  output: string;
  instanceId?: string;
  reason?: string;
}

function buildToolCtx(deps: KpiApiDispatchDeps, threadId: string): OuterToolContext {
  return {
    threadId,
    agentSid: deps.agentSid ?? resolveAgentSid(),
    workspaceId: deps.workspaceId ?? resolveWorkspaceId(),
    repoRoot: deps.repoRoot,
    imClient: (deps.imClient ?? { start() {}, destroy() {}, postMessage: async () => {} }) as ChatIRChannel,
    assetStore: deps.assetStore,
    getEngine: deps.getEngine,
    workspaceStore: deps.workspaceStore,
    repoStore: deps.repoStore,
    dataRoot: deps.dataRoot,
    innerBrainRegistry: deps.innerBrainRegistry,
    kpiRegistry: deps.kpiRegistry,
    memoryStore: deps.memoryStore ?? undefined,
    skillStore: deps.skillStore,
    skillDrive9Store: deps.skillDrive9Store,
    knowledgeDrive9Store: deps.knowledgeDrive9Store,
    scheduleReflexionBurst: deps.scheduleReflexionBurst,
    scheduleNextKpiBurst: deps.scheduleNextKpiBurst,
  };
}

/** 从 set_goal 工具输出解析 instance_id */
function parseInstanceId(output: string): string | undefined {
  const m = output.match(/instance_id=([^\s,，]+)/);
  return m?.[1];
}

/**
 * 为 active KPI 派发一发内脑 burst（等同外脑 `set_goal` + `kpi_id`）。
 */
export async function dispatchKpiBurst(
  deps: KpiApiDispatchDeps,
  kpiId: string,
  input: KpiApiDispatchInput = {},
): Promise<KpiApiDispatchResult> {
  const kpi = deps.kpiRegistry.get(kpiId);
  if (!kpi) {
    return { ok: false, output: '', reason: 'kpi_not_found' };
  }
  if (kpi.status !== 'active') {
    return { ok: false, output: '', reason: `kpi_status_${kpi.status}` };
  }

  const decision = evaluateKpiAutonomyDispatch(
    deps.kpiRegistry,
    deps.innerBrainRegistry,
    kpiId,
  );
  if (!decision.ok) {
    return { ok: false, output: '', reason: decision.reason };
  }

  const goal = (input.goal?.trim() || kpi.description).trim();
  if (!goal) {
    return { ok: false, output: '', reason: 'goal_empty' };
  }

  const threadId =
    input.origin_thread?.trim() ||
    deps.defaultThreadId?.trim() ||
    process.env['UTLRA_OUTER_HEARTBEAT_THREAD_ID']?.trim() ||
    'thread:ops';

  const toolOut = await executeOuterTool(
    'set_goal',
    JSON.stringify({
      goal,
      kpi_id: kpiId,
      origin_thread: threadId,
      ...(input.origin_user?.trim() ? { origin_user: input.origin_user.trim() } : {}),
    }),
    buildToolCtx(deps, threadId),
  );

  if (!isSetGoalDispatched(toolOut.output)) {
    return { ok: false, output: toolOut.output, reason: 'set_goal_failed' };
  }

  return {
    ok: true,
    output: toolOut.output,
    instanceId: parseInstanceId(toolOut.output),
  };
}
