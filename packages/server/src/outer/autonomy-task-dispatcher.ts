/**
 * 自主任务 handler 注册表 + KPI 优先 / 性格概率闲聊 dispatch。
 */
import type { ChatIRChannel } from '@utlra/chat-ir';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { llmRawChatCompletion } from '../llm/raw.js';
import { loadInboundConfigFromEnv } from './inbound-policy.js';
import { getGroupParticipationState, recordProactiveSpeak } from './participation-state.js';
import type { KpiRegistry } from './kpi-registry.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { executeOuterTool, type OuterToolContext } from './outer-tools.js';
import { loadSoul } from './soul.js';
import { anyInnerBrainAsyncWaiting } from './resource-probe.js';
import {
  loadAutonomyPolicy,
  markAutonomousAction,
} from './autonomy-policy-store.js';
import { loadPersonality } from './personality.js';
import { logAutonomyDispatch } from './autonomy-action-log.js';
import {
  isTaskOnCooldown,
  isTaskOverDailyLimit,
  recordTaskDispatch,
} from './autonomy-task-state.js';
import type {
  AgentPersonality,
  AutonomyDispatchResult,
  AutonomyPolicy,
  AutonomyTaskType,
  AutonomyVerdict,
  ResourceSnapshot,
} from './autonomy-types.js';

export interface AutonomyDispatchDeps {
  dataRoot: string;
  agentSid: string;
  workspaceId: string;
  defaultThreadId: string;
  registry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  imClient: ChatIRChannel | null;
  toolCtx: OuterToolContext;
  getLlmEnv: () => InnerLlmEnv | null;
}

function taskConfig(policy: AutonomyPolicy, id: AutonomyTaskType) {
  return policy.taskTypes[id] ?? { enabled: false, cooldownMs: 0, maxPerDay: 0 };
}

function hasActiveKpi(kpiRegistry: KpiRegistry): boolean {
  return kpiRegistry.list({ status: 'active' }).length > 0;
}

function canSpawnInner(snapshot: ResourceSnapshot, registry: InnerBrainRegistry, policy: AutonomyPolicy): boolean {
  const g = policy.hardGates;
  if (snapshot.innerBrains.running >= g.maxRunningInnerBrains) return false;
  if (snapshot.innerBrains.awaiting >= g.maxAwaitingInnerBrains) return false;
  if (anyInnerBrainAsyncWaiting(registry)) return false;
  return true;
}

function taskEligible(
  dataRoot: string,
  policy: AutonomyPolicy,
  taskType: AutonomyTaskType,
): { ok: boolean; reason: string } {
  const cfg = taskConfig(policy, taskType);
  if (!cfg.enabled) return { ok: false, reason: `${taskType}_disabled` };
  if (isTaskOnCooldown(dataRoot, taskType, cfg.cooldownMs)) {
    return { ok: false, reason: `${taskType}_cooldown` };
  }
  if (isTaskOverDailyLimit(dataRoot, taskType, cfg.maxPerDay)) {
    return { ok: false, reason: `${taskType}_max_per_day` };
  }
  return { ok: true, reason: 'ok' };
}

async function draftKpiGoal(
  env: InnerLlmEnv,
  kpiRegistry: KpiRegistry,
  soul: string,
): Promise<{ goal: string; kpiId: string } | null> {
  const kpis = kpiRegistry.list({ status: 'active' });
  if (kpis.length === 0) return null;
  const kpi = kpis[0]!;
  const trail = kpiRegistry.recentReflexions(kpi.kpiId, 2);
  const trailText =
    trail.length > 0
      ? trail.map((t) => `- ${t.verdict}: ${t.nextStrategy}`).join('\n')
      : '（无历史反思）';

  const { raw } = await llmRawChatCompletion<{ choices?: Array<{ message?: { content?: string } }> }>({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    body: {
      model: env.textModel,
      temperature: 0.4,
      max_tokens: 800,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'system',
          content:
            `${soul}\n\n你是外脑规划器。根据 KPI 设计一条**可执行**的内脑 goal（Markdown，≤400 字）。只输出 goal 正文，不要解释。`,
        },
        {
          role: 'user',
          content: `KPI：${kpi.description}\n最近反思：\n${trailText}\n\n请给出下一轮内脑目标。`,
        },
      ],
    },
  });
  const goal = raw.choices?.[0]?.message?.content?.trim() ?? '';
  if (!goal) return null;
  return { goal, kpiId: kpi.kpiId };
}

async function executeKpiInnerGoal(deps: AutonomyDispatchDeps): Promise<AutonomyDispatchResult> {
  const env = deps.getLlmEnv();
  if (!env) return { dispatched: false, reason: 'no_llm_env' };

  const soul = loadSoul(deps.dataRoot);
  const draft = await draftKpiGoal(env, deps.kpiRegistry, soul);
  if (!draft) return { dispatched: false, reason: 'kpi_goal_draft_failed' };

  const toolOut = await executeOuterTool(
    'set_goal',
    JSON.stringify({
      goal: draft.goal,
      workspace_id: deps.workspaceId,
      kpi_id: draft.kpiId,
    }),
    deps.toolCtx,
  );

  if (!toolOut.output.startsWith('已向内脑派发任务')) {
    return { dispatched: false, reason: 'set_goal_failed', detail: toolOut.output.slice(0, 200) };
  }

  return {
    dispatched: true,
    taskType: 'kpi_inner_goal',
    reason: 'kpi_inner_goal',
    detail: toolOut.output.slice(0, 200),
  };
}

function casualChatParticipationOk(threadId: string): { ok: boolean; reason: string } {
  const config = loadInboundConfigFromEnv();
  const state = getGroupParticipationState(threadId);
  const now = Date.now();
  if (now - state.lastProactiveAt < config.speakCooldownMs) {
    return { ok: false, reason: 'participation_cooldown' };
  }
  if (now - state.proactiveCountResetAt > 5 * 60 * 1000) {
    state.proactiveCount5min = 0;
    state.proactiveCountResetAt = now;
  }
  if (state.proactiveCount5min >= config.maxProactivePer5Min) {
    return { ok: false, reason: 'participation_max_5min' };
  }
  return { ok: true, reason: 'ok' };
}

async function draftCasualChatText(
  env: InnerLlmEnv,
  soul: string,
): Promise<string | null> {
  const { raw } = await llmRawChatCompletion<{ choices?: Array<{ message?: { content?: string } }> }>({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    body: {
      model: env.textModel,
      temperature: 0.7,
      max_tokens: 120,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'system',
          content: `${soul}\n\n你在外脑空闲时主动发一条 IM。要求：1-2 句，有实质内容，不要「在吗」式寒暄，不要 markdown 列表。`,
        },
        { role: 'user', content: '请生成一条适合现在发出的群聊消息。' },
      ],
    },
  });
  const text = raw.choices?.[0]?.message?.content?.trim() ?? '';
  return text || null;
}

async function executeCasualChat(
  deps: AutonomyDispatchDeps,
  personality: AgentPersonality,
): Promise<AutonomyDispatchResult> {
  if (!deps.imClient) return { dispatched: false, reason: 'no_im_client' };
  const threadId = deps.defaultThreadId.trim();
  if (!threadId) return { dispatched: false, reason: 'no_default_thread' };

  const part = casualChatParticipationOk(threadId);
  if (!part.ok) return { dispatched: false, reason: part.reason };

  if (Math.random() >= personality.idleChatProbability) {
    return { dispatched: false, reason: 'chat_probability_skip', detail: `p=${personality.idleChatProbability}` };
  }

  const env = deps.getLlmEnv();
  if (!env) return { dispatched: false, reason: 'no_llm_env' };

  const text = await draftCasualChatText(env, loadSoul(deps.dataRoot));
  if (!text) return { dispatched: false, reason: 'chat_draft_failed' };

  try {
    await deps.imClient.postMessage(threadId, {
      sender_sid: deps.agentSid,
      text,
      parse_mentions: true,
    });
    recordProactiveSpeak(threadId);
    return { dispatched: true, taskType: 'casual_chat', reason: 'casual_chat', detail: text.slice(0, 120) };
  } catch (e) {
    return {
      dispatched: false,
      reason: 'post_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function dispatchAutonomyTasks(
  deps: AutonomyDispatchDeps,
  snapshot: ResourceSnapshot,
  verdict: AutonomyVerdict,
): Promise<AutonomyDispatchResult> {
  if (verdict.level !== 'idle') {
    return { dispatched: false, reason: verdict.blockedByHardGate ?? 'busy' };
  }

  const policy = loadAutonomyPolicy(deps.dataRoot);
  const personality = loadPersonality(deps.dataRoot);

  // 1. KPI 优先
  if (hasActiveKpi(deps.kpiRegistry) && canSpawnInner(snapshot, deps.registry, policy)) {
    const elig = taskEligible(deps.dataRoot, policy, 'kpi_inner_goal');
    if (elig.ok) {
      const result = await executeKpiInnerGoal(deps);
      logAutonomyDispatch(deps.dataRoot, snapshot, result);
      if (result.dispatched) {
        recordTaskDispatch(deps.dataRoot, 'kpi_inner_goal');
        markAutonomousAction(deps.dataRoot);
      }
      return result;
    }
  }

  // 2. 闲聊候选（无 KPI 或无法 spawn）
  const chatElig = taskEligible(deps.dataRoot, policy, 'casual_chat');
  if (!chatElig.ok) {
    const result: AutonomyDispatchResult = { dispatched: false, reason: chatElig.reason };
    logAutonomyDispatch(deps.dataRoot, snapshot, result);
    return result;
  }

  const result = await executeCasualChat(deps, personality);
  logAutonomyDispatch(deps.dataRoot, snapshot, result);
  if (result.dispatched) {
    recordTaskDispatch(deps.dataRoot, 'casual_chat');
    markAutonomousAction(deps.dataRoot);
  }
  return result;
}
