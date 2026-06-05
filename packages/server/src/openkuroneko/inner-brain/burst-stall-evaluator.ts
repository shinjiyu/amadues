/**
 * DyFlow burst 级空转判定（纯函数）。
 *
 * ADL：doc/structurizr/INNER-BURST-STALL-ALERT.md §2
 */

import type { InnerMemory, NodeResult } from './types.js';

export type BurstStallSignal =
  | 'multi_cap_no_facts'
  | 'multi_cap_zero_ok'
  | 'capped_nodes_3'
  | 'run_failure_constraints_4'
  | 'long_run_no_outcome';

export interface BurstStallVerdict {
  stalled: boolean;
  severity: 'warn' | 'critical';
  signals: BurstStallSignal[];
  summary: string;
  metrics: {
    cappedCount: number;
    okNodeCount: number;
    factsCount: number;
    runFailureConstraintCount: number;
    deliverableCount: number;
    wallMs: number;
  };
}

export interface EvaluateBurstStallInput {
  memory: InnerMemory;
  deliverableCount?: number;
  startedAtMs?: number | null;
  designStreak?: number;
  longRunMs?: number;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveLongRunMs(): number {
  return readPositiveIntEnv('INNER_BURST_STALL_LONG_RUN_MS', 900_000);
}

function nodeResultsList(memory: InnerMemory): NodeResult[] {
  const nr = memory.node_results;
  if (!nr || typeof nr !== 'object') return [];
  return Object.values(nr);
}

function isCapped(r: NodeResult): boolean {
  return r.status === 'capped' || (!r.ok && r.status !== 'ok');
}

export function evaluateBurstStall(input: EvaluateBurstStallInput): BurstStallVerdict {
  const results = nodeResultsList(input.memory);
  const capped = results.filter(isCapped);
  const okNodes = results.filter(r => r.ok);
  const factsCount = input.memory.facts?.length ?? 0;
  const runFailureConstraintCount = (input.memory.constraints ?? []).filter(c =>
    String(c).includes('[run-failure]'),
  ).length;
  const deliverableCount = input.deliverableCount ?? 0;
  const wallMs =
    input.startedAtMs != null && Number.isFinite(input.startedAtMs)
      ? Math.max(0, Date.now() - input.startedAtMs)
      : 0;
  const longRunMs = input.longRunMs ?? resolveLongRunMs();

  const signals: BurstStallSignal[] = [];

  if (capped.length >= 2 && factsCount === 0) signals.push('multi_cap_no_facts');
  if (capped.length >= 2 && okNodes.length === 0) signals.push('multi_cap_zero_ok');
  if (capped.length >= 3) signals.push('capped_nodes_3');
  if (runFailureConstraintCount >= 4) signals.push('run_failure_constraints_4');
  if (wallMs >= longRunMs && factsCount === 0 && deliverableCount === 0) {
    signals.push('long_run_no_outcome');
  }

  const stalled =
    signals.includes('multi_cap_no_facts') ||
    signals.includes('multi_cap_zero_ok') ||
    signals.includes('capped_nodes_3') ||
    signals.includes('run_failure_constraints_4') ||
    signals.includes('long_run_no_outcome');

  const severity: BurstStallVerdict['severity'] =
    signals.includes('capped_nodes_3') || signals.includes('long_run_no_outcome')
      ? 'critical'
      : 'warn';

  const summary = stalled
    ? `内脑空转：${signals.join(', ')}（capped=${capped.length} ok=${okNodes.length} facts=${factsCount} deliverables=${deliverableCount}）`
    : '未达空转阈值';

  return {
    stalled,
    severity,
    signals,
    summary,
    metrics: {
      cappedCount: capped.length,
      okNodeCount: okNodes.length,
      factsCount,
      runFailureConstraintCount,
      deliverableCount,
      wallMs,
    },
  };
}

export function isBurstStallAlertEnabled(): boolean {
  const raw = process.env['INNER_BURST_STALL_ALERT']?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}
