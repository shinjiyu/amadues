import type { DueCalendarCommitment, EmployeeCalendarPort } from '../scheduler/employee-calendar.js';
import {
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
  | 'heartbeat_fallback';

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

  constructor(private readonly deps: DigitalEmployeeLoopDeps) {}

  trigger(reason: DigitalEmployeeTriggerReason): Promise<DigitalEmployeeLoopResult> {
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
      const environment = await this.deps.collectEnvironment();
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

    return { dispatched, reason: finalReason, triggerReasons };
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
