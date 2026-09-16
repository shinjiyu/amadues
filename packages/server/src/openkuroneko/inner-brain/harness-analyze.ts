/**
 * Harness analyze — periodic soft findings from run-context (pstune-analyze analogue).
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §4.1 / H6 / H9 · BATTLE-TUNE-LOOP.md
 */

import fs from 'node:fs';
import path from 'node:path';

import { readRunContext } from './run-context-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createNodeSkillStore } from './node-skill-store.js';
import { assertNoEvalLeak } from './harness-revise.js';

export const DEFAULT_ANALYZE_INTERVAL = 3;
/** Soft signal: ReAct / tool rounds per node above this → heavy_react */
export const HEAVY_REACT_ENTRY_THRESHOLD = 8;

export type HarnessFindingCode =
  | 'hard_fail'
  | 'heavy_react'
  | 'unbound_skills'
  | 'failed_nodes'
  | 'open_sorry';

/** Findings that alone justify revise on a successful RUN (H9: no empty climb). */
const ACTIONABLE_ON_SUCCESS: ReadonlySet<HarnessFindingCode> = new Set([
  'heavy_react',
  'unbound_skills',
  'failed_nodes',
]);

export interface HarnessFinding {
  code: HarnessFindingCode;
  severity: 'info' | 'warn';
  message: string;
  nodeRef?: string;
}

export interface AnalyzeCadence {
  attributeCount: number;
  interval: number;
  lastAnalyzeAt?: string;
}

export interface HarnessAnalyzeInput {
  runOk: boolean;
  /** Skip cadence gate (tests / explicit tool) */
  force?: boolean;
  interval?: number;
}

export interface HarnessAnalyzeResult {
  findings: HarnessFinding[];
  shouldRevise: boolean;
  trigger: 'cadence' | 'hard_fail' | 'forced' | 'skipped';
  reason: string;
  attributeCount: number;
  cadenceDue: boolean;
  diagnosis?: string;
}

function harnessDir(workDir: string): string {
  return path.join(workDir, '.brain', 'harness');
}

function cadencePath(workDir: string): string {
  return path.join(harnessDir(workDir), 'analyze-cadence.json');
}

export function readAnalyzeCadence(workDir: string): AnalyzeCadence {
  try {
    const raw = fs.readFileSync(cadencePath(workDir), 'utf8');
    const p = JSON.parse(raw) as Partial<AnalyzeCadence>;
    return {
      attributeCount: typeof p.attributeCount === 'number' ? p.attributeCount : 0,
      interval:
        typeof p.interval === 'number' && p.interval > 0
          ? p.interval
          : DEFAULT_ANALYZE_INTERVAL,
      ...(p.lastAnalyzeAt ? { lastAnalyzeAt: p.lastAnalyzeAt } : {}),
    };
  } catch {
    return { attributeCount: 0, interval: DEFAULT_ANALYZE_INTERVAL };
  }
}

export function writeAnalyzeCadence(workDir: string, c: AnalyzeCadence): void {
  fs.mkdirSync(harnessDir(workDir), { recursive: true });
  fs.writeFileSync(cadencePath(workDir), JSON.stringify(c, null, 2), 'utf8');
}

/** Increment ATTRIBUTE counter; returns updated cadence + whether interval is due. */
export function tickAnalyzeCadence(
  workDir: string,
  opts: { interval?: number } = {},
): { cadence: AnalyzeCadence; due: boolean } {
  const prev = readAnalyzeCadence(workDir);
  const interval = opts.interval ?? prev.interval ?? DEFAULT_ANALYZE_INTERVAL;
  const attributeCount = prev.attributeCount + 1;
  const cadence: AnalyzeCadence = {
    attributeCount,
    interval,
    ...(prev.lastAnalyzeAt ? { lastAnalyzeAt: prev.lastAnalyzeAt } : {}),
  };
  writeAnalyzeCadence(workDir, cadence);
  const due = attributeCount > 0 && attributeCount % interval === 0;
  return { cadence, due };
}

export function collectHarnessFindings(workDir: string, runOk: boolean): HarnessFinding[] {
  const findings: HarnessFinding[] = [];
  const ctx = readRunContext(workDir);
  if (!ctx) return findings;

  if (!runOk || ctx.ok === false) {
    findings.push({
      code: 'hard_fail',
      severity: 'warn',
      message: `RUN failed${ctx.failedAt ? ` at ${ctx.failedAt}` : ''}`,
    });
  }

  const failedNodes = ctx.nodes.filter((n) => !n.ok);
  for (const n of failedNodes) {
    findings.push({
      code: 'failed_nodes',
      severity: 'warn',
      message: `node ${n.ref} not ok`,
      nodeRef: n.ref,
    });
  }

  for (const n of ctx.nodes) {
    if ((n.entries?.length ?? 0) >= HEAVY_REACT_ENTRY_THRESHOLD) {
      findings.push({
        code: 'heavy_react',
        severity: 'info',
        message: `node ${n.ref} has ${n.entries.length} tool/react entries (≥${HEAVY_REACT_ENTRY_THRESHOLD})`,
        nodeRef: n.ref,
      });
    }
  }

  const store = createHarnessSpecStore(workDir);
  const active = createHarnessPointer(workDir, store).readActive();
  const spec = active ? store.get(active.harnessId) : null;
  const bound = new Set((spec?.refs.skillRefs ?? []).map((s) => `${s.nodeRef}::${s.skillId}`));
  const skillStore = createNodeSkillStore(workDir);
  for (const n of ctx.nodes) {
    const skills = skillStore.readIndex(n.ref);
    if (!skills.length) continue;
    const unbound = skills.filter((sk) => !bound.has(`${n.ref}::${sk.id}`));
    if (unbound.length > 0) {
      findings.push({
        code: 'unbound_skills',
        severity: 'info',
        message: `node ${n.ref} has ${unbound.length} skill(s) not bound on active H`,
        nodeRef: n.ref,
      });
    }
  }

  // Lean craft signal (Collatz pilot etc.): conjecture may stay open; log only
  const conjPath = path.join(workDir, 'Collatz', 'Conjecture.lean');
  if (fs.existsSync(conjPath)) {
    try {
      const src = fs.readFileSync(conjPath, 'utf8');
      if (/\bsorry\b/.test(src)) {
        findings.push({
          code: 'open_sorry',
          severity: 'info',
          message: 'Collatz/Conjecture.lean still contains sorry (open conjecture — craft ok)',
        });
      }
    } catch {
      /* ignore */
    }
  }

  return findings;
}

export function findingsToDiagnosis(findings: HarnessFinding[]): string {
  const text = findings.map((f) => `[${f.code}] ${f.message}`).join('\n');
  assertNoEvalLeak(text);
  return text.slice(0, 2000);
}

/**
 * Tick cadence, decide trigger, collect findings.
 * Does not revise/upgrade — caller (harnessRsiCycle) owns that.
 */
export function analyzeHarness(
  workDir: string,
  input: HarnessAnalyzeInput,
): HarnessAnalyzeResult {
  const { cadence, due } = tickAnalyzeCadence(workDir, {
    interval: input.interval,
  });

  const hardFail = !input.runOk;
  const forced = Boolean(input.force);
  const cadenceDue = due;

  if (!hardFail && !cadenceDue && !forced) {
    return {
      findings: [],
      shouldRevise: false,
      trigger: 'skipped',
      reason: 'cadence_wait',
      attributeCount: cadence.attributeCount,
      cadenceDue: false,
    };
  }

  const findings = collectHarnessFindings(workDir, input.runOk);
  const trigger: HarnessAnalyzeResult['trigger'] = forced
    ? 'forced'
    : hardFail
      ? 'hard_fail'
      : 'cadence';

  const actionable = hardFail
    ? findings
    : findings.filter((f) => ACTIONABLE_ON_SUCCESS.has(f.code));

  // Success + no actionable soft findings → do not empty-revise (open_sorry alone is not enough)
  if (!hardFail && actionable.length === 0) {
    writeAnalyzeCadence(workDir, {
      ...cadence,
      lastAnalyzeAt: new Date().toISOString(),
    });
    return {
      findings,
      shouldRevise: false,
      trigger,
      reason: 'no_findings',
      attributeCount: cadence.attributeCount,
      cadenceDue,
    };
  }

  const diagnosis = findingsToDiagnosis(findings);
  writeAnalyzeCadence(workDir, {
    ...cadence,
    lastAnalyzeAt: new Date().toISOString(),
  });

  // Persist audit copy (best-effort)
  try {
    const dir = path.join(harnessDir(workDir), 'analyze');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}.json`;
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ trigger, findings, actionable, diagnosis }, null, 2),
      'utf8',
    );
  } catch {
    /* ignore */
  }

  return {
    findings,
    shouldRevise: true,
    trigger,
    reason: hardFail ? 'hard_fail_revise' : 'findings_revise',
    attributeCount: cadence.attributeCount,
    cadenceDue,
    diagnosis,
  };
}
