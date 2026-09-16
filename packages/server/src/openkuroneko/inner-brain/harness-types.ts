/**
 * Inner Harness-RSI types — ADL: doc/structurizr/HARNESS-RSI.md §3 / §5 / §12
 */

export type HarnessStatus =
  | 'draft'
  | 'gated_ok'
  | 'gated_fail'
  | 'active'
  | 'superseded'
  | 'rejected';

export interface HarnessSkillRef {
  nodeRef: string;
  skillId: string;
}

export interface HarnessWorkflowRef {
  id: string;
  version: string;
}

/** Mechanical check run against workDir / loop tree (P5). */
export interface HarnessGateCheck {
  id: string;
  command: string;
  /** Relative to workDir; default workDir root */
  cwd?: string;
}

export interface HarnessRefs {
  /** P5: immutable loop source snapshot id under .brain/harness/trees/ */
  loopTreeId?: string;
  /** Relative path prefixes (within tree) patches may touch */
  loopRoots?: string[];
  /** Entry file inside tree for restart / runner */
  loopEntry?: string;
  /** Shell checks executed at gate (cwd relative to workDir) */
  gateChecks?: HarnessGateCheck[];
  localNodeIds?: string[];
  skillRefs?: HarnessSkillRef[];
  workflowRef?: HarnessWorkflowRef;
  assetPaths?: string[];
}

export interface HarnessSpec {
  id: string;
  parentId?: string;
  createdAt: string;
  refs: HarnessRefs;
  contentHash: string;
  status: HarnessStatus;
}

export interface HarnessActivePointer {
  harnessId: string;
  upgradedAt: string;
}

export interface HarnessHistoryEntry {
  ts: string;
  action: 'upgrade' | 'rollback' | 'reject';
  from?: string;
  to: string;
}

/** revise primary product — applied via COW into a new loop tree (P5 / H11). */
export interface HarnessPatch {
  path: string;
  action: 'write' | 'delete';
  content?: string;
}

export interface LoopTreeManifest {
  treeId: string;
  parentTreeId?: string;
  files: Record<string, string>;
  createdAt: string;
}
