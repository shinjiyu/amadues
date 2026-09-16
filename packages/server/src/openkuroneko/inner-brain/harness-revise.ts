/**
 * Harness revise — single parent → single H′; P5 patches → new loopTree (H6 / H8 / H11 / H12).
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §4 / §12
 * Deterministic (no LLM). Optional diagnosis string is leak-checked only.
 */

import { readRunContext } from './run-context-store.js';
import type { HarnessSpecStore } from './harness-spec-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { createNodeSkillStore } from './node-skill-store.js';
import { createHarnessLoopTreeStore } from './harness-loop-tree.js';
import type {
  HarnessPatch,
  HarnessRefs,
  HarnessSkillRef,
  HarnessSpec,
} from './harness-types.js';

const LEAK = [
  /x_eval/i,
  /kpi\s*judge/i,
  /KPI\s*评分/,
  /评分细则/,
  /scoring\s*rubric/i,
];

export interface HarnessReviseInput {
  diagnosis?: string;
  /** P5: patches applied to parent loopTree (required for effective upgrade when parent has loopTree) */
  patches?: HarnessPatch[];
  /** Optional override / seed of loopRoots on H′ */
  loopRoots?: string[];
  loopEntry?: string;
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

function hasSubstantialNonSkillChange(
  parent: HarnessRefs | undefined,
  next: HarnessRefs,
): boolean {
  if ((parent?.loopTreeId ?? null) !== (next.loopTreeId ?? null)) return true;
  if ((parent?.workflowRef?.id ?? null) !== (next.workflowRef?.id ?? null)) return true;
  if ((parent?.workflowRef?.version ?? null) !== (next.workflowRef?.version ?? null)) return true;
  const a = [...(parent?.localNodeIds ?? [])].sort().join(',');
  const b = [...(next.localNodeIds ?? [])].sort().join(',');
  if (a !== b) return true;
  const pa = [...(parent?.assetPaths ?? [])].sort().join(',');
  const na = [...(next.assetPaths ?? [])].sort().join(',');
  if (pa !== na) return true;
  return false;
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
  const orderedNodes = [...(ctx?.nodes ?? [])].sort((a, b) => Number(a.ok) - Number(b.ok));
  for (const n of orderedNodes) {
    for (const sk of skillStore.readIndex(n.ref)) {
      fromRun.push({ nodeRef: n.ref, skillId: sk.id });
    }
  }
  const skillRefs = mergeSkillRefs(parent?.refs.skillRefs, fromRun);

  const loopRoots = input.loopRoots ?? parent?.refs.loopRoots ?? [];
  const loopEntry = input.loopEntry ?? parent?.refs.loopEntry;
  let loopTreeId = parent?.refs.loopTreeId;

  const patches = input.patches ?? [];
  if (patches.length > 0) {
    if (!parent?.refs.loopTreeId) {
      throw new Error('[harness-revise] patches require parent refs.loopTreeId (seed tree first)');
    }
    const trees = createHarnessLoopTreeStore(workDir);
    const nextTree = trees.applyPatches(parent.refs.loopTreeId, patches, loopRoots.length ? loopRoots : ['']);
    loopTreeId = nextTree.treeId;
  } else if (parent?.refs.loopTreeId) {
    // P5 mode: skillRefs-only revise is not an effective H′ (H12)
    throw new Error(
      '[harness-revise] H12: parent has loopTreeId; patches required (skillRefs-only revise rejected)',
    );
  }

  const refs: HarnessRefs = {
    ...(parent?.refs ?? {}),
    ...(localNodeIds.length ? { localNodeIds } : {}),
    ...(skillRefs.length ? { skillRefs } : {}),
    ...(loopTreeId ? { loopTreeId } : {}),
    ...(loopRoots.length ? { loopRoots } : {}),
    ...(loopEntry ? { loopEntry } : {}),
  };

  if (parent?.refs.loopTreeId && !hasSubstantialNonSkillChange(parent.refs, refs)) {
    throw new Error('[harness-revise] H12: no substantial loop/refs change');
  }

  return store.put({
    parentId: parent?.id,
    refs,
    status: 'draft',
  });
}
