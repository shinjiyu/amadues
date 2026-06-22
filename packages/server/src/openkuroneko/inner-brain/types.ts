/**
 * DyFlow 内脑引擎 — 核心类型
 *
 * ADL 权威：
 *   - doc/structurizr/DYFLOW-INNER-EXECUTOR.md（FSM / NodeInst / local_dag / failure_summary）
 *   - doc/structurizr/INNER-NODE-LIFECYCLE.md（LocalNode / NodeDef schema）
 *
 * 三个概念（不要混用）：
 *   - LocalNode：具象 JSON（真实路径/账号），存 .brain/local_nodes/<id>.json
 *   - NodeInst：local_dag 里的「图格」，引用 LocalNode id
 *   - NodeDef：脱敏模板（placeholder），存 drive9 /nodes/shared/（P1）
 */

// ── 节点来源 ──────────────────────────────────────────────────────────────────

export type NodeOrigin = 'preset' | 'creator' | 'imported';

// ── interface 契约 ───────────────────────────────────────────────────────────

export interface NodeInputSpec {
  key: string;
  type: string;
  /** NodeDef 抽象后的 placeholder 名（仅模板态有意义） */
  placeholder?: string;
}

export interface NodeOutputSpec {
  key: string;
  /** string | file | json — 见 DYFLOW-INNER-EXECUTOR.md §6.7 */
  type: string;
}

/** NodeInst 可选验收策略（§6.7） */
export interface NodeAcceptance {
  /** 默认 true：interface.outputs 全部验票通过才算 ok */
  requireAllOutputs?: boolean;
  /** P1：至少满足的 output key → partial */
  minOutputs?: string[];
}

// ── 节点级交付物（§6.7a：机械验票，与 report_done 闸门 §9a 共用引擎） ──────────

export type DeliverableCheckKind = 'file' | 'json_key' | 'stdout_contains' | 'stdout_absent';

export interface DeliverableCheck {
  kind: DeliverableCheckKind;
  /**
   * file: workDir 相对路径；
   * json_key: "rel.json#a.b.c"（# 后为点路径）；
   * stdout_contains / stdout_absent: 待匹配子串
   */
  target: string;
  /** 人类可读：这条交付物代表什么 */
  describe?: string;
}

/** Designer 在编排时为单个 NodeInst 声明的「必须交付什么 + 怎么机械验」 */
export interface NodeDeliverable {
  /** 一句话说清本节点必须交付什么 */
  summary: string;
  /** 机械可验的检查项；全部通过才算节点 ok（与 interface.outputs 取 AND） */
  checks: DeliverableCheck[];
}

export type NodeOutcomeStatus = 'ok' | 'partial' | 'capped' | 'failed';

export interface NodeInterface {
  inputs: NodeInputSpec[];
  /** baseNode 必须全部满足才算 ok；缺失即 terminal failure */
  outputs: NodeOutputSpec[];
}

// ── body：executor（baseNode）或 graph（compound） ──────────────────────────

/** 节点绑定技能索引（正文存 local_nodes/skills/；见 INNER-NODE-SKILLS.md） */
export interface NodeSkillRef {
  id: string;
  category: string;
  title: string;
  tags?: string[];
}

/** NodeDef 共享技能（含正文，Assembler 写入本地技能目录） */
export interface NodeDefSkill extends NodeSkillRef {
  content: string;
}

export interface BodyExecutor {
  kind: 'executor';
  /** 可含 ${{ memory.x }} / ${{ params.y }} 占位 */
  promptTemplate: string;
  /** 角色/约束附加（system slice 追加） */
  systemSlice?: string;
  /** baseNode 工具 allowlist（工具名，须能被 worker 进程解析） */
  tools: string[];
  defaultParams?: Record<string, unknown>;
}

export interface BodyGraph {
  kind: 'graph';
  /** 子图（≠ Designer 当前 local_dag） */
  nodes: NodeInst[];
  edges?: GraphEdge[];
  entry?: string;
  /** 暴露给父图 memory 的 key */
  exports: { from: string; as: string }[];
}

export type NodeBody = BodyExecutor | BodyGraph;

// ── LocalNode ─────────────────────────────────────────────────────────────────

export interface LocalNodeProvenance {
  fromNodeInsts?: string[];
  fromBurst?: string;
  /** Assembler 装配理由（≤1KB） */
  bindingRationale?: string;
}

export interface LocalNodeMetadata {
  origin: NodeOrigin;
  /** imported 时记 NodeDef id@version */
  sourceDef?: string;
  provenance?: LocalNodeProvenance;
  /** 此 LocalNode 适用的 workDir（Assembler 装配时写） */
  workDir?: string;
  /** false 时 Abstractor 跳过 export */
  export?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocalNode {
  /** 形如 "preset/base" / "local/ps_open_battle" / "imported/<defId>@<ver>" */
  id: string;
  /** semver-like：1.0.0；同 id 升版本不改 ref */
  version: string;
  displayName: string;
  description: string;
  tags: string[];
  /** 节点绑定技能索引（Attributor / promote / Assembler 写入） */
  skills?: NodeSkillRef[];
  interface: NodeInterface;
  body: NodeBody;
  metadata: LocalNodeMetadata;
}

// ── NodeInst（local_dag 里的一格） ──────────────────────────────────────────

export interface NodeInst {
  /** local_dag 内唯一 */
  id: string;
  /** LocalNode id */
  ref: string;
  /** φ：Designer 本轮细指令；可选 */
  instruction?: string;
  /** 覆盖 LocalNode 默认（路径/账号 binding） */
  params?: Record<string, unknown>;
  /** 额外读哪些 memory key（默认 goal + last_failure + node_results.<id>） */
  memoryIn?: string[];
  /** 写回 memory 的 key 名（默认 node_results.<id>） */
  memoryOut?: string[];
  /** 可选验收策略；缺省仅按 LocalNode.interface.outputs 机械验票 */
  acceptance?: NodeAcceptance;
  /** 节点级交付物（§6.7a）：存在时与 interface.outputs 取 AND，全部 check 通过才算 ok */
  deliverable?: NodeDeliverable;
  /** 该节点服务的里程碑标签（§9c）；命中已锁定里程碑时 commit_local_dag 拒收 */
  milestone?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

// ── local_dag ─────────────────────────────────────────────────────────────────

export interface LocalDag {
  burstId: string;
  designedAt: string;
  nodes: NodeInst[];
  /** P0 默认按 nodes[] 顺序串行；可省略 */
  edges?: GraphEdge[];
  /** 默认 nodes[0] */
  entry?: string;
  notes?: string;
}

// ── failure_summary（terminal failure 时写 memory.last_failure） ─────────────

export type FailureConfidence = 'high' | 'low';

export interface FailureSummary {
  nodeInstId: string;
  localRef: string;
  /** 一段话：原因 + 影响 */
  summary: string;
  /** 关键尝试列表（不堆原始 stderr） */
  attempted: string[];
  /** 默认 high；唯有 transient 信号才 low */
  confidence: FailureConfidence;
  /** true → Designer 可考虑同 ref 重排 */
  transient?: boolean;
  /** 截断的 ≤1KB 原始 tail（debug 用） */
  rawTail?: string;
  at: string;
}

// ── node_results（runner 写入 memory） ──────────────────────────────────────

export interface NodeResult {
  nodeInstId: string;
  ref: string;
  ok: boolean;
  /** 机械完成态（§6.7）；缺省时由 ok + failure 推断 */
  status?: NodeOutcomeStatus;
  /** ok 时 interface.outputs 的实际值 */
  outputs?: Record<string, unknown>;
  /** 失败时同 FailureSummary（也镜像写 memory.last_failure） */
  failure?: FailureSummary;
  at: string;
}

// ── locked_milestones（持久「已完成子目标」记忆，§9c） ──────────────────────

export interface LockedMilestone {
  /** 语义 id（Designer 自取；与 NodeInst.milestone 对应） */
  id: string;
  /** 这个里程碑达成了什么 */
  summary: string;
  lockedAt: string;
  /** 锁定时通过的机械证据（供后续复核 / 外脑） */
  evidence?: DeliverableCheck[];
}

// ── dag_history（每轮 RUN 后归档的计划序列记忆，§6.8） ──────────────────────

export interface DagHistoryNode {
  id: string;
  ref: string;
  /** 截断后的 instruction（≤200） */
  instruction?: string;
  /** 节点结果状态；未执行到为 pending */
  status: NodeOutcomeStatus | 'pending';
  /** NodeInst.deliverable.summary（若有） */
  deliverable?: string;
}

export interface DagHistoryEntry {
  burstId: string;
  designedAt: string;
  finishedAt: string;
  /** 整图是否全绿 */
  ok: boolean;
  /** 失败 nodeInstId */
  failedAt?: string;
  nodes: DagHistoryNode[];
  notes?: string;
}

// ── 全局 memory（.brain/memory.json） ───────────────────────────────────────

export type FactStatus = 'active' | 'superseded' | 'retracted';
export type FactConfidence = 'verified' | 'hypothesis' | 'obsolete';

export interface FactSource {
  burstId?: string;
  nodeInstId?: string;
  at: string;
  via?: 'record_fact' | 'attributor' | 'seed' | 'promote';
}

/** 结构化事实记录（ADL：FACTS-KNOWLEDGE-GOVERNANCE.md §3） */
export interface FactRecord {
  id: string;
  topic: string;
  content: string;
  status: FactStatus;
  confidence: FactConfidence;
  source: FactSource;
  supersedes?: string;
  citeCount: number;
  lastCitedAt?: string;
  tags: string[];
  needsReconcile?: boolean;
}

/** 启发式检测到的 fact 矛盾对（ADL §5.3） */
export interface FactConflictEntry {
  domain: string;
  factIds: [string, string];
  reason: string;
  detectedAt: string;
}

export interface InnerMemory {
  /** 战略目标（外脑/seed 写） */
  goal?: string;
  /** KPI 级红线（外脑 set_goal / KPI policy 写） */
  constraints: string[];
  /** 环境事实（extract_facts / 外脑 seed 写）；与 fact_records 中 active 同步 */
  facts: string[];
  /** 结构化事实（治理主存储；facts[] 为 prompt 兼容投影） */
  fact_records?: FactRecord[];
  /** 启发式检测到的矛盾 fact 对（ATTRIBUTE sweep 写入） */
  fact_conflicts?: FactConflictEntry[];
  /** runner 写入的最近一次 terminal failure */
  last_failure?: FailureSummary | null;
  /** @deprecated 旧 node_creator pack 失败；node_creator 已移除（2026-06-06），仅为读旧 memory 保留 */
  last_pack_error?: string | null;
  /** node_results.<nodeInstId> = NodeResult */
  node_results: Record<string, NodeResult>;
  /** 每轮 RUN 后归档的 DAG 计划序列记忆（环形，§6.8） */
  dag_history?: DagHistoryEntry[];
  /** 已锁定里程碑（持久「已完成子目标」，§9c；commit 机械拦截重排） */
  locked_milestones?: LockedMilestone[];
  /** KPI 进度（Designer 自报 / 外脑写） */
  kpi_progress?: Record<string, unknown>;
  /** 自由扩展键（Designer / baseNode 写读，需声明 memoryIn/memoryOut） */
  [key: string]: unknown;
}

// ── 新 FSM 控制器状态（独立于 legacy ControllerState） ──────────────────────

export type DyflowMode = 'DESIGN' | 'RUN' | 'ATTRIBUTE' | 'AWAITING' | 'DONE' | 'ERROR' | 'STOPPED';

export interface DyflowState {
  mode: DyflowMode;
  /** 当前 burst（registry id） */
  burstId?: string;
  /** 进入 DONE / ERROR 的原因 */
  reason?: string | null;
  /** DESIGN 连续空图 / 异常计数，用于兜底 */
  designStreak?: number;
  updatedAt: string;
}

// ── NodeDef（drive9 共享模板，P1；P0 仅类型占位） ────────────────────────────

export type PlaceholderKind = 'path' | 'account' | 'room' | 'secret' | 'other';

export interface NodeDefPlaceholder {
  name: string;
  kind: PlaceholderKind;
  required: boolean;
  exampleHint?: string;
}

export interface NodeDefMetadata {
  sourceAgent: string;
  sourceLocalId: string;
  /** body 结构 hash，用于去重 */
  dedupeKey: string;
  citeCount: number;
  importCount: number;
  assembleFailCount: number;
  createdAt: string;
  lastImportedAt?: string;
  status: 'active' | 'tombstone';
}

export interface NodeDef {
  id: string;
  version: string;
  description: string;
  tags: string[];
  placeholders: NodeDefPlaceholder[];
  /** 共享技能包（Abstractor 从 LocalNode 技能目录导出） */
  skills?: NodeDefSkill[];
  interface: NodeInterface;
  /** 与 LocalNode body 同结构，但字符串字段含 ${{ NAME }} */
  body: NodeBody;
  metadata: NodeDefMetadata;
}

// ── 节点库索引（.brain/local_nodes/index.json） ──────────────────────────────

export interface LocalNodeIndexEntry {
  id: string;
  version: string;
  displayName: string;
  description: string;
  tags: string[];
  origin: NodeOrigin;
  kind: NodeBody['kind'];
  updatedAt: string;
}

export interface LocalNodeIndex {
  entries: LocalNodeIndexEntry[];
  updatedAt: string;
}
