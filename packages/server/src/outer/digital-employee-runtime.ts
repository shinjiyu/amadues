import path from 'node:path';

import { Scheduler } from '../scheduler/index.js';
import { EmployeeCalendar } from '../scheduler/employee-calendar.js';
import { listActivePendings } from '../openkuroneko/pendings/index.js';
import { appendAutonomyActionLog } from './autonomy-action-log.js';
import { DigitalEmployeeLoop, type DigitalEmployeeTriggerReason } from './digital-employee-loop.js';
import {
  collectEnvironmentSnapshot,
  getSharedEnvironment,
  hasAvailableCapacity,
  loadAutonomyPolicy,
} from './environment/index.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { isSetGoalDispatched } from './inner-brain-kpi-reuse.js';
import { listBlockedRoutes } from './kpi/kpi-failure-circuit.js';
import type { KpiRegistry } from './kpi-registry.js';
import { executeOuterTool, type OuterToolContext } from './outer-tools.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { buildSelfWorkLlmCaller } from './self-work-llm-policy.js';
import { SelfWorkMetricsTracker } from './self-work-metrics.js';
import type { SelfWorkProposal } from './self-work-policy.js';
import { createSelfWorkPolicy } from './self-work-strategies.js';

export interface DigitalEmployeeRuntimeDeps {
  dataRoot: string;
  agentSid: string;
  defaultThreadId: string;
  registry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  toolCtx: OuterToolContext;
  getOrchestratorStats?: () => { queuedTotal: number; activeThreads: number };
  duePollMs?: number;
  /**
   * SelfWork 策略 spec（默认 conservative；可经 UTLRA_SELF_WORK_STRATEGY 覆盖）：
   * 单策略 id | 'llm_reflective' | 'ab' | 'ab:a,b'
   */
  selfWorkStrategy?: string;
  /** llm_reflective 策略需要；缺失时降级 conservative */
  getLlmEnv?: () => InnerLlmEnv | null;
}

function resolveStrategySpec(deps: DigitalEmployeeRuntimeDeps): string {
  return deps.selfWorkStrategy ?? process.env['UTLRA_SELF_WORK_STRATEGY'] ?? 'conservative';
}

export class DigitalEmployeeRuntime {
  private readonly scheduler: Scheduler;
  private readonly loop: DigitalEmployeeLoop;
  private readonly metrics: SelfWorkMetricsTracker;
  private dueTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DigitalEmployeeRuntimeDeps) {
    this.metrics = new SelfWorkMetricsTracker(deps.dataRoot);
    this.scheduler = new Scheduler({
      dataRoot: deps.dataRoot,
      deferMissedExecution: true,
    });
    this.scheduler.configureCallbacks({
      executePromptAction: async (taskId, prompt) => {
        const task = (await this.scheduler.listTasks()).find((candidate) => candidate.id === taskId);
        const kpiId = typeof task?.metadata['kpiId'] === 'string' ? task.metadata['kpiId'] : undefined;
        const result = await executeOuterTool(
          'set_goal',
          JSON.stringify({ goal: prompt, kpi_id: kpiId, origin_thread: deps.defaultThreadId }),
          { ...deps.toolCtx, allowKpiSetGoal: Boolean(kpiId) },
        );
        if (!isSetGoalDispatched(result.output)) throw new Error(result.output);
        return result.output;
      },
      executeToolCallAction: async (_taskId, toolName, params) => {
        const result = await executeOuterTool(toolName, JSON.stringify(params), deps.toolCtx);
        return result.output;
      },
      executeSendMessageAction: async (_taskId, target, content) => {
        await deps.toolCtx.imClient.postMessage(target || deps.defaultThreadId, {
          sender_sid: deps.agentSid,
          text: content,
        });
        return 'message_sent';
      },
      isAgentBusy: () => false,
    });

    const calendar = new EmployeeCalendar(this.scheduler);
    this.loop = new DigitalEmployeeLoop({
      collectEnvironment: async () => {
        const shared = getSharedEnvironment(deps.dataRoot);
        const { snapshot } = collectEnvironmentSnapshot(
          {
            agentId: deps.agentSid,
            registry: deps.registry,
            defaultThreadId: deps.defaultThreadId,
            getOrchestratorStats: deps.getOrchestratorStats,
          },
          shared.registry,
          shared.journal,
        );
        const policy = loadAutonomyPolicy(deps.dataRoot);
        const capacity = hasAvailableCapacity(snapshot, policy);
        const tasks = deps.registry.list();
        const pendingDependencies = tasks
          .filter((task) => task.status === 'AWAITING' || task.status === 'BLOCKED')
          .flatMap((task) => {
            try {
              return listActivePendings(path.join(task.workDir, '.brain')).map(
                (pending) => `${task.instanceId}:${pending.id}`,
              );
            } catch {
              return [];
            }
          });
        const recentActions = deps.kpiRegistry
          .list()
          .flatMap((kpi) => kpi.burstRunHistory.slice(-10).map((run) => run.charter))
          .filter(Boolean);

        return {
          capacity: {
            available: capacity.available,
            freeInnerSlots: capacity.freeInnerSlots,
            reason: capacity.reason,
          },
          activeKpis: deps.kpiRegistry.list({ status: 'active' }),
          pendingDependencies,
          runningConflicts: tasks
            .filter((task) => task.status === 'RUNNING')
            .map((task) => task.goal),
          recentActions,
          blockedRoutes: listBlockedRoutes(deps.kpiRegistry, deps.registry),
        };
      },
      calendar,
      selfWorkPolicy: this.buildSelfWorkPolicy(),
      dispatchProposal: (proposal) => this.dispatchProposal(proposal),
      log: (entry) => {
        appendAutonomyActionLog(deps.dataRoot, {
          at: new Date().toISOString(),
          dispatched: entry.dispatched,
          reason: `digital_employee:${entry.reason}`,
          detail: entry.detail,
        });
        this.recordMetric(entry);
      },
    });
  }

  private buildSelfWorkPolicy() {
    const llmEnv = this.deps.getLlmEnv?.() ?? null;
    const { policy, spec } = createSelfWorkPolicy(resolveStrategySpec(this.deps), {
      getSummary: () => this.metrics.summarize(),
      llmCaller: llmEnv ? buildSelfWorkLlmCaller(llmEnv) : undefined,
    });
    appendAutonomyActionLog(this.deps.dataRoot, {
      at: new Date().toISOString(),
      dispatched: false,
      reason: 'digital_employee:self_work_strategy',
      detail: spec,
    });
    return policy;
  }

  private recordMetric(entry: {
    kind: string;
    reason: string;
    strategyId?: string;
  }): void {
    const at = new Date().toISOString();
    if (entry.kind === 'self_work') {
      this.metrics.record({ at, kind: 'accepted', reason: entry.reason, strategyId: entry.strategyId });
    } else if (entry.kind === 'reject') {
      this.metrics.record({ at, kind: 'rejected', reason: entry.reason, strategyId: entry.strategyId });
    } else if (entry.kind === 'sleep' && entry.reason === 'no_valuable_work') {
      this.metrics.record({ at, kind: 'slept', reason: entry.reason });
    } else if (entry.kind === 'error' && entry.reason === 'self_work_dispatch_failed') {
      this.metrics.record({ at, kind: 'dispatch_failed', reason: entry.reason, strategyId: entry.strategyId });
    }
  }

  getMetrics(): SelfWorkMetricsTracker {
    return this.metrics;
  }

  async start(): Promise<void> {
    await this.scheduler.start();
    const pollMs = Math.max(250, this.deps.duePollMs ?? 1_000);
    this.dueTimer = setInterval(() => {
      void this.triggerIfDue();
    }, pollMs);
    this.dueTimer.unref?.();
    await this.triggerIfDue();
  }

  async stop(): Promise<void> {
    if (this.dueTimer) {
      clearInterval(this.dueTimer);
      this.dueTimer = null;
    }
    await this.scheduler.stop();
  }

  trigger(reason: DigitalEmployeeTriggerReason): Promise<unknown> {
    return this.loop.trigger(reason);
  }

  getScheduler(): Scheduler {
    return this.scheduler;
  }

  private async triggerIfDue(): Promise<void> {
    const due = await new EmployeeCalendar(this.scheduler).listDue();
    if (due.length > 0) await this.loop.trigger('calendar_due');
  }

  private async dispatchProposal(proposal: SelfWorkProposal): Promise<void> {
    const goal = [
      `# 数字员工工作包`,
      '',
      `## KPI`,
      proposal.kpiId,
      '',
      `## 动作`,
      proposal.action,
      '',
      `## 预期产出`,
      proposal.expectedOutcome,
      '',
      `## 原因与策略`,
      `${proposal.reason}（${proposal.strategyId}）`,
    ].join('\n');
    const result = await executeOuterTool(
      'set_goal',
      JSON.stringify({
        goal,
        kpi_id: proposal.kpiId,
        origin_thread: this.deps.defaultThreadId,
      }),
      { ...this.deps.toolCtx, allowKpiSetGoal: true },
    );
    if (!isSetGoalDispatched(result.output)) throw new Error(result.output);
  }
}
