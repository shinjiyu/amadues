// ============================================================
// 核心类型定义 — 不死 Agent 心跳检测原型
// ============================================================

// ----- 行为日志 -----

/** 行为操作类型 */
export type OperationType =
  | "born"       // agent 初始化事件
  | "act"        // 产生外部可观测副作用
  | "respond"    // 响应外部输入
  | "communicate"; // 与其他 agent 交互

/** 行为日志条目 — 只有 Environment 侧能写入 */
export interface LogEntry {
  /** 时间戳（毫秒精度） */
  timestamp: number;
  /** 操作类型 */
  operation_type: OperationType;
  /** 影响范围 — 描述该行为的外部可观测影响 */
  impact_scope: string;
}

// ----- Agent 状态 -----

/** Agent 存活状态 */
export type AgentStatus = "alive" | "dead" | "unborn";

/** Agent 状态快照 — 环境侧定期拉取用于心跳比对 */
export interface AgentStateSnapshot {
  /** agent 唯一标识 */
  agentId: string;
  /** 当前存活状态 */
  status: AgentStatus;
  /** 内部状态摘要（可被环境侧读取但不可被 agent 伪造行为日志） */
  stateHash: string;
}

// ----- Agent 接口 -----

/** Agent 感知到的自身信息 */
export interface AgentPerception {
  /** 自身 agentId */
  agentId: string;
  /** 当前状态 */
  status: AgentStatus;
}

/** Agent 行动请求 — agent 通过此结构请求环境执行副作用 */
export interface AgentAction {
  /** 操作类型 */
  operation_type: Exclude<OperationType, "born">; // born 只在初始化时由环境写入
  /** 影响范围描述 */
  impact_scope: string;
}

/**
 * Agent 接口 — agent 侧的感知与行动能力
 *
 * - perceive(): 感知自身状态
 * - act(action): 通过环境产生外部可观测副作用
 *
 * agent 不能直接写入行为日志，必须通过 Environment.act() 产生副作用
 */
export interface Agent {
  /** agent 唯一标识 */
  readonly id: string;
  /** 感知自身状态 */
  perceive(): AgentPerception;
  /** 请求执行行动（由环境侧写入行为日志） */
  act(action: AgentAction): void;
}

// ----- Environment 接口 -----

/** 心跳检测配置 */
export interface HeartbeatConfig {
  /** 连续无变化次数阈值，达到即判定死亡（默认 3） */
  readonly maxMissed: number;
  /** 心跳检测间隔（毫秒） */
  readonly intervalMs: number;
}

/** 默认心跳配置 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  maxMissed: 3,
  intervalMs: 1000,
};

/**
 * Environment 接口 — 环境侧的写入权与心跳检测
 *
 * - 唯一拥有行为日志写入权的实体
 * - 定期拉取 agent 状态快照，比对变化
 * - 连续 N 次无变化 → 判定死亡
 * - born 事件在 agent 初始化时由环境写入
 */
export interface Environment {
  /** 注册 agent，写入 born 事件；注册失败则 agent 视为死亡 */
  registerAgent(agent: Agent): void;
  /** 执行 agent 行动，写入行为日志（唯一写入入口） */
  act(agentId: string, action: AgentAction): void;
  /** 获取 agent 的行为日志（只读） */
  getLog(agentId: string): ReadonlyArray<LogEntry>;
  /** 获取 agent 当前状态快照 */
  getSnapshot(agentId: string): AgentStateSnapshot | undefined;
  /** 执行一次心跳检测，返回仍存活的 agent 列表 */
  heartbeat(): string[];
  /** 获取心跳配置 */
  readonly config: HeartbeatConfig;
}
