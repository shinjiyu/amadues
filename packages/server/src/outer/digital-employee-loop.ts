import type { DueCalendarCommitment, EmployeeCalendarPort } from '../scheduler/employee-calendar.js';
import {
  isRouteBlocked,
  validateSelfWorkProposal,
  type SelfWorkContext,
  type SelfWorkPolicy,
  type SelfWorkProposal,
} from './self-work-policy.js';

export type DigitalEmployeeTriggerReason =
  | 'burst_finished'
  | 'calendar_due'
  | 'dependency_resolved'
  | 'inbound_drained'
  | 'policy_changed'
  | 'heartbeat_fallback'
  | 'drive_threshold';

/** Subject-chosen work. The loop validates this proposal and does not ask SelfWorkPolicy. */
export interface SubjectWorkProposal {
  kind: 'kpi_advance' | 'ad_hoc';
  kpiId?: string;
  goalText: string;
  expectedOutcome: string;
  drive: 'curiosity' | 'completion';
}

export interface AvailableCapacity {
  available: boolean;
  freeInnerSlots: number;
  reason?: string;
}

export interface DigitalEmployeeEnvironment extends SelfWorkContext {
  capacity: AvailableCapacity;
}

export interface DigitalEmployeeLoopResult {
  dispatched: number;
  reason: string;
  triggerReasons: DigitalEmployeeTriggerReason[];
  /** True only when the attached subject proposal itself was set_goal'd. */
  subjectProposalDispatched: boolean;
}

export interface DigitalEmployeeLoopLog {
  triggerReasons: DigitalEmployeeTriggerReason[];
  kind: 'calendar' | 'self_work' | 'sleep' | 'reject' | 'error';
  dispatched: boolean;
  reason: string;
  detail?: string;
  /** self_work / reject 时的提案策略，供指标统计 */
  strategyId?: string;
}

export interface DigitalEmployeeLoopDeps {
  collectEnvironment(): Promise<DigitalEmployeeEnvironment>;
  calendar: EmployeeCalendarPort;
  selfWorkPolicy: SelfWorkPolicy;
  dispatchProposal(proposal: SelfWorkProposal): Promise<void>;
  /** One-shot set_goal without kpi_id. Used only for subject kind=ad_hoc. */
  dispatchAdHoc?(input: { goalText: string; expectedOutcome: string }): Promise<void>;
  /**
   * 基线已完成时幂等 ensure 周期日历（ADV-6）。返回新建条数；
   * 若 >0，loop 会重新采集环境再跑 SelfWork。
   */
  ensureAdvanceCalendars?(environment: DigitalEmployeeEnvironment): Promise<number>;
  log?: (entry: DigitalEmployeeLoopLog) => void;
  maxDispatchesPerTrigger?: number;
}

/**
 * Capacity-driven, single-flight work loop.
 *
 * Triggers arriving during a run share the same promise. This intentionally
 * coalesces event storms: after each successful dispatch the loop recollects
 * capacity, so a separate concurrent runner is unnecessary and unsafe.
 */
export class DigitalEmployeeLoop {
  private inFlight: Promise<DigitalEmployeeLoopResult> | null = null;
  private readonly pendingReasons = new Set<DigitalEmployeeTriggerReason>();
  private subjectTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DigitalEmployeeLoopDeps) {}

  trigger(
    reason: DigitalEmployeeTriggerReason,
    options?: { subjectProposal?: SubjectWorkProposal },
  ): Promise<DigitalEmployeeLoopResult> {
    if (options?.subjectProposal) {
      const proposal = options.subjectProposal;
      const run = this.subjectTail.then(async () => {
        if (this.inFlight) await this.inFlight;
        const promise = this.runSubject(proposal);
        this.inFlight = promise.finally(() => {
          if (this.inFlight === promise) this.inFlight = null;
        });
        return this.inFlight;
      });
      this.subjectTail = run.then(() => undefined, () => undefined);
      return run;
    }

    this.pendingReasons.add(reason);
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
      this.pendingReasons.clear();
    });
    return this.inFlight;
  }

  private async run(): Promise<DigitalEmployeeLoopResult> {
    const triggerReasons = [...this.pendingReasons];
    const maxDispatches = Math.max(1, this.deps.maxDispatchesPerTrigger ?? 3);
    let dispatched = 0;
    let finalReason = 'no_valuable_work';
    const actionsThisRun: string[] = [];

    while (dispatched < maxDispatches) {
      let environment = await this.deps.collectEnvironment();
      if (!environment.capacity.available || environment.capacity.freeInnerSlots <= 0) {
        finalReason = environment.capacity.reason ?? 'no_available_capacity';
        this.writeLog(triggerReasons, 'sleep', false, finalReason);
        break;
      }

      const due = await this.deps.calendar.listDue();
      const commitment = due[0];
      if (commitment) {
        try {
          await this.deps.calendar.execute(commitment.id);
          dispatched += 1;
          finalReason = 'calendar_dispatched';
          this.writeCalendarLog(triggerReasons, commitment);
          continue;
        } catch (error) {
          finalReason = 'calendar_dispatch_failed';
          this.writeLog(
            triggerReasons,
            'error',
            false,
            finalReason,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
      }

      if (this.deps.ensureAdvanceCalendars) {
        try {
          const created = await this.deps.ensureAdvanceCalendars(environment);
          if (created > 0) {
            this.writeLog(
              triggerReasons,
              'calendar',
              false,
              'calendar_ensured',
              `created=${created}`,
            );
            environment = await this.deps.collectEnvironment();
          }
        } catch (error) {
          finalReason = 'calendar_ensure_failed';
          this.writeLog(
            triggerReasons,
            'error',
            false,
            finalReason,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
      }

      const proposalContext: DigitalEmployeeEnvironment = {
        ...environment,
        recentActions: [...environment.recentActions, ...actionsThisRun],
      };
      const proposal = await this.deps.selfWorkPolicy.propose(proposalContext);
      if (!proposal) {
        finalReason = 'no_valuable_work';
        this.writeLog(triggerReasons, 'sleep', false, finalReason);
        break;
      }

      const validation = validateSelfWorkProposal(proposal, proposalContext);
      if (!validation.ok) {
        finalReason = validation.reason;
        this.writeLog(triggerReasons, 'reject', false, validation.reason, proposal.action, proposal.strategyId);
        break;
      }

      try {
        await this.deps.dispatchProposal(proposal);
        dispatched += 1;
        actionsThisRun.push(proposal.action);
        finalReason = 'self_work_dispatched';
        this.writeLog(triggerReasons, 'self_work', true, finalReason, proposal.action, proposal.strategyId);
      } catch (error) {
        finalReason = 'self_work_dispatch_failed';
        this.writeLog(
          triggerReasons,
          'error',
          false,
          finalReason,
          error instanceof Error ? error.message : String(error),
          proposal.strategyId,
        );
        break;
      }
    }

    return { dispatched, reason: finalReason, triggerReasons, subjectProposalDispatched: false };
  }

  /**
   * drive_threshold: capacity, then a due calendar, then only the subject proposal.
   * SelfWorkPolicy is not consulted. A due calendar is dispatched and the proposal is left for the caller to defer.
   */
  private async runSubject(proposal: SubjectWorkProposal): Promise<DigitalEmployeeLoopResult> {
    const triggerReasons: DigitalEmployeeTriggerReason[] = ['drive_threshold'];
    const environment = await this.deps.collectEnvironment();
    if (!environment.capacity.available || environment.capacity.freeInnerSlots <= 0) {
      const reason = environment.capacity.reason ?? 'no_available_capacity';
      this.writeLog(triggerReasons, 'sleep', false, reason);
      return { dispatched: 0, reason, triggerReasons, subjectProposalDispatched: false };
    }

    const due = await this.deps.calendar.listDue();
    const commitment = due[0];
    if (commitment) {
      try {
        await this.deps.calendar.execute(commitment.id);
        this.writeCalendarLog(triggerReasons, commitment);
        return {
          dispatched: 1,
          reason: 'calendar_dispatched',
          triggerReasons,
          subjectProposalDispatched: false,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.writeLog(triggerReasons, 'error', false, 'calendar_dispatch_failed', detail);
        return {
          dispatched: 0,
          reason: 'calendar_dispatch_failed',
          triggerReasons,
          subjectProposalDispatched: false,
        };
      }
    }

    if (proposal.kind === 'ad_hoc') {
      const validation = validateAdHocSubjectProposal(proposal, environment);
      if (!validation.ok || !this.deps.dispatchAdHoc) {
        this.writeLog(triggerReasons, 'reject', false, 'subject_proposal_rejected', validation.reason);
        return {
          dispatched: 0,
          reason: 'subject_proposal_rejected',
          triggerReasons,
          subjectProposalDispatched: false,
        };
      }
      try {
        await this.deps.dispatchAdHoc({
          goalText: proposal.goalText,
          expectedOutcome: proposal.expectedOutcome,
        });
        this.writeLog(triggerReasons, 'self_work', true, 'self_work_dispatched', proposal.goalText, 'subject');
        return {
          dispatched: 1,
          reason: 'self_work_dispatched',
          triggerReasons,
          subjectProposalDispatched: true,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.writeLog(triggerReasons, 'error', false, 'self_work_dispatch_failed', detail, 'subject');
        return {
          dispatched: 0,
          reason: 'self_work_dispatch_failed',
          triggerReasons,
          subjectProposalDispatched: false,
        };
      }
    }

    const selfWork: SelfWorkProposal = {
      kpiId: proposal.kpiId ?? '',
      action: proposal.goalText,
      expectedOutcome: proposal.expectedOutcome,
      reason: 'subject_propose_self_work',
      strategyId: 'subject',
    };
    const validation = validateSelfWorkProposal(selfWork, environment);
    if (!validation.ok) {
      this.writeLog(triggerReasons, 'reject', false, 'subject_proposal_rejected', validation.reason, 'subject');
      return {
        dispatched: 0,
        reason: 'subject_proposal_rejected',
        triggerReasons,
        subjectProposalDispatched: false,
      };
    }
    try {
      await this.deps.dispatchProposal(selfWork);
      this.writeLog(triggerReasons, 'self_work', true, 'self_work_dispatched', selfWork.action, 'subject');
      return {
        dispatched: 1,
        reason: 'self_work_dispatched',
        triggerReasons,
        subjectProposalDispatched: true,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.writeLog(triggerReasons, 'error', false, 'self_work_dispatch_failed', detail, 'subject');
      return {
        dispatched: 0,
        reason: 'self_work_dispatch_failed',
        triggerReasons,
        subjectProposalDispatched: false,
      };
    }
  }

  private writeCalendarLog(
    triggerReasons: DigitalEmployeeTriggerReason[],
    commitment: DueCalendarCommitment,
  ): void {
    this.writeLog(triggerReasons, 'calendar', true, 'calendar_dispatched', commitment.id);
  }

  private writeLog(
    triggerReasons: DigitalEmployeeTriggerReason[],
    kind: DigitalEmployeeLoopLog['kind'],
    dispatched: boolean,
    reason: string,
    detail?: string,
    strategyId?: string,
  ): void {
    this.deps.log?.({ triggerReasons, kind, dispatched, reason, detail, strategyId });
  }
}

function validateAdHocSubjectProposal(
  proposal: SubjectWorkProposal,
  context: SelfWorkContext,
): { ok: boolean; reason: string } {
  const action = proposal.goalText.trim();
  const outcome = proposal.expectedOutcome.trim();
  if (!action) return { ok: false, reason: 'action_missing' };
  if (!outcome) return { ok: false, reason: 'expected_outcome_missing' };
  const norm = (value: string) => value.trim().toLocaleLowerCase();
  if (context.recentActions.some((row) => norm(row) === norm(action))) {
    return { ok: false, reason: 'duplicate_action' };
  }
  if (context.runningConflicts.some((row) => norm(row) === norm(action))) {
    return { ok: false, reason: 'running_conflict' };
  }
  if (isRouteBlocked(action, context.blockedRoutes)) {
    return { ok: false, reason: 'route_blocked' };
  }
  return { ok: true, reason: 'ok' };
}
