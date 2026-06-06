/**
 * DyFlow 内脑引擎 — 公共入口（barrel）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md / INNER-NODE-LIFECYCLE.md
 */

export * from './types.js';
export { createLocalNodeStore } from './local-node-store.js';
export type { LocalNodeStore } from './local-node-store.js';
export { createMemoryStore } from './memory-store.js';
export type { MemoryStore } from './memory-store.js';
export { seedPresetNodes } from './preset-seeder.js';
export { PRESET_NODES, PRESET_BASE } from './preset-nodes.js';
export { runBaseNode } from './base-node-executor.js';
export type { BaseNodeOutcome } from './base-node-executor.js';
export { createCommitLocalNodeTool } from './commit-local-node-tool.js';
export { runLocalDag } from './runner.js';
export type { RunnerResult, RunnerDeps } from './runner.js';
export { runDesigner, DESIGNER_SYSTEM, buildDesignerSystemPrompt } from './designer.js';
export type { DesignerOutcome } from './designer.js';
export { createDesignerTools } from './designer-tools.js';
export type { NodeSharingDeps } from './designer-tools.js';
export { readLocalDag, writeLocalDag, clearLocalDag } from './local-dag-store.js';
export { createDyflowController } from './controller.js';
export { evaluateBurstStall, isBurstStallAlertEnabled } from './burst-stall-evaluator.js';
export type { BurstStallVerdict, BurstStallSignal } from './burst-stall-evaluator.js';
export {
  maybeEmitBurstStallAlert,
  listStallAlertIndex,
  readStallAlertBundle,
  STALL_ALERT_SCHEMA,
} from './burst-stall-alert.js';
export type { StallAlertIndexEntry, BurstStallAlertBundle } from './burst-stall-alert.js';
export type {
  DyflowController,
  DyflowControllerContext,
  DyflowControllerDeps,
  NodeSharingConfig,
} from './controller.js';
// P1：节点共享（drive9）
export { abstractLocalNode, validateSanitized, ABSTRACTOR_SYSTEM } from './node-abstractor.js';
export type { AbstractorResult, EnvSnapshot } from './node-abstractor.js';
export { assembleNodeDef, applyBinding, importedId, ASSEMBLER_SYSTEM } from './node-assembler.js';
export type { AssembleResult } from './node-assembler.js';
