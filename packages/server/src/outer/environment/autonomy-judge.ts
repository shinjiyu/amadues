/**
 * 闲忙判定 — ADL ENVIRONMENT-MODEL.md §9.1（自 outer/autonomy-judge.ts 迁入）
 */
import type { AutonomyPolicy, AutonomyVerdict, ResourceSnapshot } from '../autonomy-types.js';

export function evaluateHardGates(
  snapshot: ResourceSnapshot,
  policy: AutonomyPolicy,
  nowMs = Date.now(),
): AutonomyVerdict {
  const reasons: string[] = [];
  const g = policy.hardGates;

  if (!policy.enabled) {
    return {
      level: 'busy',
      reasons: ['autonomy_disabled'],
      blockedByHardGate: 'policy.enabled=false',
      judgedAt: new Date(nowMs).toISOString(),
    };
  }

  if (process.env['UTLRA_AUTONOMY_ENABLED'] === '0') {
    return {
      level: 'busy',
      reasons: ['env_autonomy_disabled'],
      blockedByHardGate: 'UTLRA_AUTONOMY_ENABLED=0',
      judgedAt: new Date(nowMs).toISOString(),
    };
  }

  if (snapshot.innerBrains.running >= g.maxRunningInnerBrains) {
    return busy(`running_inner=${snapshot.innerBrains.running}>=${g.maxRunningInnerBrains}`, reasons, nowMs);
  }
  if (snapshot.llm.inFlight >= g.maxLlmInFlight) {
    return busy(`llm_in_flight=${snapshot.llm.inFlight}>=${g.maxLlmInFlight}`, reasons, nowMs);
  }
  if (g.maxTokensPerHour != null && snapshot.llm.tokensLast1h.total >= g.maxTokensPerHour) {
    return busy(`tokens_1h=${snapshot.llm.tokensLast1h.total}>=${g.maxTokensPerHour}`, reasons, nowMs);
  }
  if (policy.lastAutonomousActionAt) {
    const last = Date.parse(policy.lastAutonomousActionAt);
    if (Number.isFinite(last) && nowMs - last < g.minMsSinceLastAutonomousAction) {
      return busy(`min_interval_ms not elapsed`, reasons, nowMs);
    }
  }
  if (snapshot.inbound.orchestratorQueuedTotal > g.blockIfOrchestratorQueuedAbove) {
    return busy(
      `orchestrator_queued=${snapshot.inbound.orchestratorQueuedTotal}>${g.blockIfOrchestratorQueuedAbove}`,
      reasons,
      nowMs,
    );
  }
  if (g.blockIfOuterLoopActive && snapshot.inbound.outerLoopActiveThreads > 0) {
    return busy(`outer_loop_active=${snapshot.inbound.outerLoopActiveThreads}`, reasons, nowMs);
  }

  reasons.push('hard_gates_pass');
  return {
    level: 'idle',
    reasons,
    judgedAt: new Date(nowMs).toISOString(),
  };
}

function busy(blockedByHardGate: string, reasons: string[], nowMs: number): AutonomyVerdict {
  reasons.push(blockedByHardGate);
  return {
    level: 'busy',
    reasons,
    blockedByHardGate,
    judgedAt: new Date(nowMs).toISOString(),
  };
}

export function evaluateAutonomyVerdict(
  snapshot: ResourceSnapshot,
  policy: AutonomyPolicy,
  nowMs = Date.now(),
): AutonomyVerdict {
  return evaluateHardGates(snapshot, policy, nowMs);
}
