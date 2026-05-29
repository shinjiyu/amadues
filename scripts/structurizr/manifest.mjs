/**
 * Kuroneko Structurizr generator manifest — single source for L2/L3 ids and code paths.
 * Edit here when refactoring; generator reads this to avoid granularity drift.
 */

export const SOFTWARE_SYSTEM = {
  id: 'kuroneko',
  name: 'Kuroneko (utlra)',
  description: 'Generated from code — review before replacing workspace.dsl',
};

export const EXTERNAL_SYSTEMS = [
  { id: 'discord', name: 'Discord', description: 'External IM' },
  { id: 'llm', name: 'LLM', description: 'LLM providers' },
  { id: 'mem9', name: 'mem9', description: 'Cloud memory' },
  { id: 'drive9', name: 'drive9', description: 'Skill/knowledge storage' },
];

/** L2 containers: npm package or app → Structurizr container */
export const L2_CONTAINERS = [
  { id: 'chatIrLib', kind: 'library', name: 'Chat IR', technology: 'npm @utlra/chat-ir', path: 'packages/chat-ir', packageName: '@utlra/chat-ir' },
  { id: 'workspaceKit', kind: 'library', name: 'Workspace Kit', technology: 'server/workspace-kit (inlined)', path: 'packages/server/src/workspace-kit', packageName: null },
  { id: 'webchatProtocolLib', kind: 'library', name: 'WebChat Protocol', technology: 'npm @utlra/webchat-protocol', path: 'packages/webchat-protocol', packageName: '@utlra/webchat-protocol' },
  { id: 'agentServer', kind: 'process', name: 'Agent Server', technology: 'Node.js @utlra/server', path: 'packages/server', packageName: '@utlra/server', parent: 'kuroneko' },
  { id: 'innerWorker', kind: 'process', name: 'Inner Brain Worker', technology: 'Node.js child_process', path: 'packages/server/src/pi-mono/inner-brain-worker.ts', packageName: '@utlra/server', parent: 'kuroneko' },
  { id: 'discordBridge', kind: 'process', name: 'Discord Bridge', technology: 'npm @utlra/discord-bridge', path: 'packages/discord-bridge', packageName: '@utlra/discord-bridge' },
  { id: 'webchatBridge', kind: 'process', name: 'WebChat Bridge', technology: 'npm @utlra/webchat-bridge', path: 'packages/webchat-bridge', packageName: '@utlra/webchat-bridge' },
  { id: 'chatServer', kind: 'process', name: 'Chat Server', technology: 'apps/chat-server', path: 'apps/chat-server', packageName: '@utlra/chat-server' },
  { id: 'webChat', kind: 'process', name: 'Web Chat UI', technology: 'apps/web-chat', path: 'apps/web-chat', packageName: '@utlra/web-chat' },
];

/** packageName → container id for import edges */
export const PACKAGE_TO_CONTAINER = Object.fromEntries(
  L2_CONTAINERS.filter((c) => c.packageName).map((c) => [c.packageName, c.id]),
);

/** L3 components under a parent L2 container */
export const L3_COMPONENTS = {
  agentServer: [
    { id: 'participationPolicy', name: 'Participation Policy', path: 'packages/server/src/outer/inbound-policy.ts' },
    { id: 'outerBrainFacade', name: 'Outer Brain Facade', path: 'packages/server/src/outer/outer-brain.ts' },
    { id: 'knowledgeRetrieval', name: 'Knowledge Retrieval', path: 'packages/server/src/outer/knowledge-retrieval.ts' },
    { id: 'threadOrchestrator', name: 'Thread Orchestrator', path: 'packages/server/src/outer/thread-orchestrator.ts' },
    { id: 'outerConversationLoop', name: 'Outer Conversation Loop', path: 'packages/server/src/outer/outer-conversation-loop.ts' },
    { id: 'outerToolExecutor', name: 'Outer Tool Executor', path: 'packages/server/src/outer/outer-tools.ts' },
    { id: 'outerOrchestrator', name: 'Outer Orchestrator', path: 'packages/server/src/outer/orchestrator.ts' },
    { id: 'innerBrainRegistry', name: 'Inner Brain Registry', path: 'packages/server/src/outer/inner-brain-registry.ts' },
    { id: 'innerSpawner', name: 'Inner Spawner', path: 'packages/server/src/pi-mono/inner-brain-spawner.ts' },
    { id: 'kpiRegistry', name: 'KPI Registry', path: 'packages/server/src/outer/kpi-registry.ts' },
    { id: 'kpiBurstHooks', name: 'KPI Burst Hooks', path: 'packages/server/src/outer/kpi-burst-hooks.ts' },
    { id: 'outerHeartbeat', name: 'Outer Heartbeat', path: 'packages/server/src/outer/outer-heartbeat.ts' },
    { id: 'performanceGoalEngine', name: 'Performance Goal Engine', path: 'packages/server/src/performance-goals/engine.ts' },
    { id: 'llmUsageTracker', name: 'LLM Usage Tracker', path: 'packages/server/src/outer/llm-usage-tracker.ts' },
    { id: 'resourceProbe', name: 'Resource Probe', path: 'packages/server/src/outer/resource-probe.ts' },
    { id: 'autonomyPolicyStore', name: 'Autonomy Policy Store', path: 'packages/server/src/outer/autonomy-policy-store.ts' },
    { id: 'autonomyJudge', name: 'Autonomy Judge', path: 'packages/server/src/outer/autonomy-judge.ts' },
    { id: 'agentPersonality', name: 'Agent Personality', path: 'packages/server/src/outer/personality.ts' },
    { id: 'autonomyTaskDispatcher', name: 'Autonomy Task Dispatcher', path: 'packages/server/src/outer/autonomy-task-dispatcher.ts' },
    { id: 'outerMemory', name: 'Outer Memory', path: 'packages/server/src/outer/outer-memory.ts' },
    { id: 'completionNotify', name: 'Completion Notify', path: 'packages/server/src/outer/completion-notify.ts' },
    { id: 'pushLoop', name: 'Push Loop', path: 'packages/server/src/outer/push-loop.ts' },
    { id: 'changeWatcher', name: 'Change Watcher', path: 'packages/server/src/pi-mono/change-watcher.ts' },
    { id: 'llmGateway', name: 'LLM Gateway', path: 'packages/server/src/llm' },
  ],
  innerWorker: [
    { id: 'workerHost', name: 'Worker Host', path: 'packages/server/src/pi-mono/inner-brain-worker.ts' },
    { id: 'piMonoScheduler', name: 'Pi-mono Scheduler', path: 'packages/server/src/pi-mono/run-tick.ts' },
    { id: 'controllerFsm', name: 'Controller FSM', path: 'packages/server/src/openkuroneko/controller/controller.ts' },
    { id: 'decomposer', name: 'Decomposer', path: 'packages/server/src/openkuroneko/controller/decomposer.ts' },
    { id: 'executor', name: 'Executor', path: 'packages/server/src/openkuroneko/controller/executor.ts' },
    { id: 'attributor', name: 'Attributor', path: 'packages/server/src/openkuroneko/controller/attributor.ts' },
    { id: 'reflexionModule', name: 'Reflexion', path: 'packages/server/src/openkuroneko/controller/reflexion.ts' },
    { id: 'blockResolver', name: 'Block Resolver', path: 'packages/server/src/openkuroneko/controller/block-resolver.ts' },
    { id: 'brainFs', name: 'Brain FS', path: 'packages/server/src/openkuroneko/brain/brain-fs.ts' },
    { id: 'archiveStore', name: 'Archive Store', path: 'packages/server/src/openkuroneko/archive/fs-store.ts' },
  ],
};

/** Optional L3 internal edges (parentContainer, src, dst, tags) */
export const L3_RELATIONSHIPS = [
  ['agentServer', 'participationPolicy', 'llmGateway', 'http'],
  ['agentServer', 'outerBrainFacade', 'participationPolicy', 'import'],
  ['agentServer', 'outerConversationLoop', 'outerToolExecutor', 'import'],
  ['agentServer', 'innerBrainRegistry', 'innerSpawner', 'spawn'],
  ['agentServer', 'outerHeartbeat', 'resourceProbe', 'import'],
  ['agentServer', 'outerHeartbeat', 'autonomyJudge', 'import'],
  ['agentServer', 'changeWatcher', 'innerSpawner', 'spawn'],
  ['agentServer', 'autonomyTaskDispatcher', 'outerToolExecutor', 'import'],
  ['agentServer', 'autonomyTaskDispatcher', 'agentPersonality', 'import'],
  ['agentServer', 'autonomyTaskDispatcher', 'kpiRegistry', 'import'],
  ['agentServer', 'resourceProbe', 'innerBrainRegistry', 'import'],
  ['agentServer', 'resourceProbe', 'llmUsageTracker', 'import'],
  ['innerWorker', 'controllerFsm', 'decomposer', 'import'],
  ['innerWorker', 'controllerFsm', 'executor', 'import'],
  ['innerWorker', 'controllerFsm', 'attributor', 'import'],
];

/**
 * Granularity presets — ALWAYS pass explicitly; default is l2 only (safest).
 */
export const GRANULARITY = {
  l1: {
    label: 'L1 only (system context)',
    l2: false,
    l3Outer: false,
    l3Inner: false,
    importEdges: false,
    l3InternalEdges: false,
  },
  l2: {
    label: 'L2 containers + libraries (no L3, no import scan)',
    l2: true,
    l3Outer: false,
    l3Inner: false,
    importEdges: false,
    l3InternalEdges: false,
  },
  'l2-imports': {
    label: 'L2 + npm import edges between workspace packages',
    l2: true,
    l3Outer: false,
    l3Inner: false,
    importEdges: true,
    l3InternalEdges: false,
  },
  'l3-outer': {
    label: 'L2 + agentServer L3 modules (manifest)',
    l2: true,
    l3Outer: true,
    l3Inner: false,
    importEdges: true,
    l3InternalEdges: false,
  },
  'l3-inner': {
    label: 'L2 + innerWorker L3 modules (manifest)',
    l2: true,
    l3Outer: false,
    l3Inner: true,
    importEdges: false,
    l3InternalEdges: true,
  },
  'l3-full': {
    label: 'L2 + all L3 + import + internal L3 edges',
    l2: true,
    l3Outer: true,
    l3Inner: true,
    importEdges: true,
    l3InternalEdges: true,
  },
};

export const GRANULARITY_KEYS = Object.keys(GRANULARITY);
