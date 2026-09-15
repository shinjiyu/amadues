/**
 * Inner Harness-RSI types — ADL: doc/structurizr/HARNESS-RSI.md §3 / §5
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

export interface HarnessRefs {
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
