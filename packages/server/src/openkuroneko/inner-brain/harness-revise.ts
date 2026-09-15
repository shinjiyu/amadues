/**
 * Harness revise — single parent → single H′ from run-context + bound skills; no eval-rubric leak.
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §4 / H6 / H8
 * Deterministic (no LLM). Optional diagnosis string is leak-checked only.
 */

import { readRunContext } from './run-context-store.js';
import type { HarnessSpecStore } from './harness-spec-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { createNodeSkillStore } from './node-skill-store.js';
import type { HarnessRefs, HarnessSkillRef, HarnessSpec } from './harness-types.js';

const LEAK = [
  /x_eval/i,
  /kpi\s*judge/i,
  /KPI\s*评分/,
  /评分细则/,
  /scoring\s*rubric/i,
];

export interface HarnessReviseInput {
  diagnosis?: string;
}

export interface HarnessReviseOpts {
  store?: HarnessSpecStore;
}

export function assertNoEvalLeak(text: string | undefined): void {
  const s = text?.trim();
  if (!s) return;
  for (const re of LEAK) {
    if (re.test(s)) {
      throw new Error(
        `[harness-revise] H6: revise input must not contain eval rubric / x_eval (matched ${re})`,
      );
    }
  }
}

function mergeSkillRefs(a: HarnessSkillRef[] = [], b: HarnessSkillRef[] = []): HarnessSkillRef[] {
  const seen = new Set<string>();
  const out: HarnessSkillRef[] = [];
  for (const s of [...b, ...a]) {
    const k = `${s.nodeRef}::${s.skillId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ nodeRef: s.nodeRef, skillId: s.skillId });
  }
  return out;
}

export function reviseHarness(
  workDir: string,
  input: HarnessReviseInput = {},
  opts: HarnessReviseOpts = {},
): HarnessSpec {
  assertNoEvalLeak(input.diagnosis);
  const store = opts.store ?? createHarnessSpecStore(workDir);
  const active = createHarnessPointer(workDir, store).readActive();
  const parent = active ? store.get(active.harnessId) : null;
  const ctx = readRunContext(workDir);
  if (!parent && !ctx) {
    throw new Error('[harness-revise] need active H or run-context');
  }

  const nodeRefs = (ctx?.nodes ?? []).map((n) => n.ref).filter(Boolean);
  const localNodeIds = [...new Set([...(parent?.refs.localNodeIds ?? []), ...nodeRefs])];

  const skillStore = createNodeSkillStore(workDir);
  const fromRun: HarnessSkillRef[] = [];
  // Failed nodes first so their skills land ahead in merge order
  const orderedNodes = [...(ctx?.nodes ?? [])].sort((a, b) => Number(a.ok) - Number(b.ok));
  for (const n of orderedNodes) {
    for (const sk of skillStore.readIndex(n.ref)) {
      fromRun.push({ nodeRef: n.ref, skillId: sk.id });
    }
  }
  const skillRefs = mergeSkillRefs(parent?.refs.skillRefs, fromRun);

  const refs: HarnessRefs = {
    ...(parent?.refs ?? {}),
    ...(localNodeIds.length ? { localNodeIds } : {}),
    ...(skillRefs.length ? { skillRefs } : {}),
  };

  return store.put({
    parentId: parent?.id,
    refs,
    status: 'draft',
  });
}
