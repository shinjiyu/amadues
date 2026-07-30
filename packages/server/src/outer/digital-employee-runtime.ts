import path from 'node:path';

import { Scheduler } from '../scheduler/index.js';
import {
  CALENDAR_DUE_TOOL_CALL_ALLOWLIST,
  EmployeeCalendar,
} from '../scheduler/employee-calendar.js';
import { listActivePendings } from '../openkuroneko/pendings/index.js';
import {
  collectAdvancePerception,
  isBootstrapDoneFromHistory,
} from './advance-perception.js';
import { ensureCalendarsAfterBootstrap } from './advance-allocator.js';
import {
  loadAdvanceCursors,
  syncAdvanceCursorsFromKpiHistory,
  upsertAdvanceCursor,
} from './advance-cursor-store.js';
import {
  AdvanceMetricsTracker,
  detectAdvancePackageKind,
} from './advance-metrics.js';
import { listStallAlertIndex } from '../openkuroneko/inner-brain/burst-stall-alert.js';
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
import { listPausedWorkflowRoutes } from './workflow-failure-circuit.js';
import type { KpiRegistry } from './kpi-registry.js';
import { executeOuterTool, type OuterToolContext } from './outer-tools.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { buildSelfWorkLlmCaller } from './self-work-llm-policy.js';
import { SelfWorkMetricsTracker } from './self-work-metrics.js';
import type { SelfWorkProposal } from './self-work-policy.js';
import { createSelfWorkPolicy } from './self-work-strategies.js';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { findWorkflowRefForKpi } from './workflow-for-kpi.js';
import {
  markEvolutionDispatched,
  WorkflowEvolutionSelfWorkPolicy,
} from './workflow-evolution-policy.js';

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
  private readonly calendar: EmployeeCalendar;
  private readonly loop: DigitalEmployeeLoop;
  private readonly metrics: SelfWorkMetricsTracker;
  private readonly advanceMetrics: AdvanceMetricsTracker;
  private dueTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DigitalEmployeeRuntimeDeps) {
    this.metrics = new SelfWorkMetricsTracker(deps.dataRoot);
    this.advanceMetrics = new AdvanceMetricsTracker(deps.dataRoot);
    this.scheduler = new Scheduler({
      dataRoot: deps.dataRoot,
      deferMissedExecution: true,
    });
    this.scheduler.configureCallbacks({
      executePromptAction: async (taskId, prompt) => {
        const task = (await this.scheduler.listTasks()).find((candidate) => candidate.id === taskId);
        const kpiId = typeof task?.metadata['kpiId'] === 'string' ? task.metadata['kpiId'] : undefined;
        const originThread =
          typeof task?.metadata['originThreadId'] === 'string'
            ? task.metadata['originThreadId']
            : deps.defaultThreadId;
        const ewStore =
          deps.toolCtx.executableWorkflowStore ??
          new ExecutableWorkflowStore({ dataRoot: deps.dataRoot });
        const wfRef = kpiId ? findWorkflowRefForKpi(ewStore, kpiId) : null;
        const result = await executeOuterTool(
          'set_goal',
          JSON.stringify({
            goal: prompt,
            kpi_id: kpiId,
            origin_thread: originThread,
            ...(wfRef
              ? {
                  burst_mode: 'execute',
                  workflow_id: wfRef.id,
                  workflow_version: wfRef.version,
                }
              : {}),
          }),
          { ...deps.toolCtx, allowKpiSetGoal: Boolean(kpiId) },
        );
        if (!isSetGoalDispatched(result.output)) throw new Error(result.output);
        if (kpiId) {
          this.advanceMetrics.record({
            at: new Date().toISOString(),
            kind: 'dispatch',
            kpiId,
            packageKind: detectAdvancePackageKind(prompt),
            hadPerception: true,
            reason: wfRef ? 'calendar_due_execute' : 'calendar_due',
          });
          upsertAdvanceCursor(deps.dataRoot, kpiId, {
            bootstrapDone: true,
            sinceAt: new Date().toISOString(),
          });
        }
        return result.output;
      },
      executeToolCallAction: async (_taskId, toolName, params) => {
        if (!CALENDAR_DUE_TOOL_CALL_ALLOWLIST.has(toolName)) {
          throw new Error(`calendar_tool_call_not_allowlisted:${toolName}`);
        }
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

    this.calendar = new EmployeeCalendar(this.scheduler);
    // 对话环工具注入同一 calendar 实例
    deps.toolCtx.employeeCalendar = this.calendar;
    this.loop = new DigitalEmployeeLoop({
      collectEnvironment: async () => this.collectEnvironment(this.calendar),
      calendar: this.calendar,
      ensureAdvanceCalendars: async (environment) => {
        if (!environment.perception || !this.calendar.ensurePeriodicCommitment) return 0;
        const outcome = await ensureCalendarsAfterBootstrap({
          kpis: environment.activeKpis,
          perception: environment.perception,
          agentId: deps.agentSid,
          ensure: (input) => this.calendar.ensurePeriodicCommitment!(input),
        });
        const at = new Date().toISOString();
        for (const row of outcome.results) {
          this.advanceMetrics.record({
            at,
            kind: 'calendar_ensure',
            kpiId: row.kpiId,
            calendarKey: row.calendarKey,
            created: row.created,
            hadPerception: true,
          });
        }
        return outcome.created;
      },
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

  private async collectEnvironment(calendar: EmployeeCalendar) {
    const shared = getSharedEnvironment(this.deps.dataRoot);
    const { snapshot } = collectEnvironmentSnapshot(
      {
        agentId: this.deps.agentSid,
        registry: this.deps.registry,
        defaultThreadId: this.deps.defaultThreadId,
        getOrchestratorStats: this.deps.getOrchestratorStats,
      },
      shared.registry,
      shared.journal,
    );
    const policy = loadAutonomyPolicy(this.deps.dataRoot);
    const capacity = hasAvailableCapacity(snapshot, policy);
    const tasks = this.deps.registry.list();
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
    const recentActions = this.deps.kpiRegistry
      .list()
      .flatMap((kpi) => kpi.burstRunHistory.slice(-10).map((run) => run.charter))
      .filter(Boolean);

    const calendarViews = await calendar.listActiveCommitments();
    const stallAlerts = listStallAlertIndex(this.deps.dataRoot, 40).map((entry) => ({
      alertId: entry.alertId,
      instanceId: entry.instanceId,
      severity: entry.severity,
      signals: entry.signals,
      summary: entry.summary,
      ts: entry.ts,
    }));
    const allKpis = this.deps.kpiRegistry.list();
    syncAdvanceCursorsFromKpiHistory(this.deps.dataRoot, allKpis);
    const cursors = loadAdvanceCursors(this.deps.dataRoot);
    const sinceAtByKpi: Record<string, string> = {};
    for (const [kpiId, cursor] of Object.entries(cursors)) {
      if (cursor.sinceAt) sinceAtByKpi[kpiId] = cursor.sinceAt;
    }
    const perception = collectAdvancePerception({
      tasks,
      calendarTasks: calendarViews.map((view) => ({
        id: view.id,
        name: view.title,
        status: view.status,
        nextRunAt: view.nextRunAt,
        metadata: {
          kpiId: view.kpiId,
          expectedOutcome: view.expectedOutcome,
          calendarKey: view.calendarKey,
        },
      })),
      kpiBootstrapFlags: allKpis.map((kpi) => ({
        kpiId: kpi.kpiId,
        bootstrapDone:
          isBootstrapDoneFromHistory(kpi.burstRunHistory) ||
          Boolean(cursors[kpi.kpiId]?.bootstrapDone),
      })),
      sinceAtByKpi,
      stallAlerts,
    });

    return {
      capacity: {
        available: capacity.available,
        freeInnerSlots: capacity.freeInnerSlots,
        reason: capacity.reason,
      },
      activeKpis: this.deps.kpiRegistry.list({ status: 'active' }),
      pendingDependencies,
      runningConflicts: tasks
        .filter((task) => task.status === 'RUNNING')
        .map((task) => task.goal),
      recentActions,
      blockedRoutes: [
        ...listBlockedRoutes(this.deps.kpiRegistry, this.deps.registry),
        ...listPausedWorkflowRoutes(
          this.deps.toolCtx.executableWorkflowStore ??
            new ExecutableWorkflowStore({ dataRoot: this.deps.dataRoot }),
        ),
      ],
      perception,
      pickWorkflowRef: (kpiId: string) => {
        const store =
          this.deps.toolCtx.executableWorkflowStore ??
          new ExecutableWorkflowStore({ dataRoot: this.deps.dataRoot });
        return findWorkflowRefForKpi(store, kpiId);
      },
    };
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
    return new WorkflowEvolutionSelfWorkPolicy(this.deps.dataRoot, policy);
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

  getAdvanceMetrics(): AdvanceMetricsTracker {
    return this.advanceMetrics;
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

  getCalendar(): EmployeeCalendar {
    return this.calendar;
  }

  private async triggerIfDue(): Promise<void> {
    const due = await this.calendar.listDue();
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
        ...(proposal.burstMode === 'execute' && proposal.workflowRef
          ? {
              burst_mode: 'execute',
              workflow_id: proposal.workflowRef.id,
              workflow_version: proposal.workflowRef.version,
            }
          : {}),
      }),
      { ...this.deps.toolCtx, allowKpiSetGoal: true },
    );
    if (!isSetGoalDispatched(result.output)) throw new Error(result.output);

    if (proposal.purpose === 'ew_revision' && proposal.evolutionId) {
      markEvolutionDispatched(this.deps.dataRoot, proposal.evolutionId);
    }

    const packageKind = detectAdvancePackageKind(proposal.action);
    this.advanceMetrics.record({
      at: new Date().toISOString(),
      kind: 'dispatch',
      kpiId: proposal.kpiId,
      packageKind,
      hadPerception: true,
      reason: proposal.reason,
    });
    if (packageKind === 'repair') {
      upsertAdvanceCursor(this.deps.dataRoot, proposal.kpiId, {
        sinceAt: new Date().toISOString(),
      });
    }
  }
}
