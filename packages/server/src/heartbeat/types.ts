/**
 * 心跳检测核心类型定义
 *
 * 设计原则：
 * - Agent 的"状态"定义为外部可观测行为，不是内部变量
 * - 环境持有行为日志的写权限，agent 无法伪造
 * - 只有产生外部可观测副作用的行为才算"变化"，纯内部计算不算行动
 */

// ─── 行为日志 ───────────────────────────────────────────────

/**
 * 行为日志条目
 *
 * 每条记录代表 agent 的一次外部可观测行为。
 * 环境侧写入，agent 只读。
 */
export interface ActionLogEntry {
  /** Unix 毫秒时间戳 */
  timestamp: number;
  /** 操作类型（如 "born"、"file_write"、"api_call"、"message_send"） */
  operation_type: string;
  /** 影响范围描述（如 "workspace:abc/file:main.ts"） */
  impact_scope: string;
}

/**
 * born 事件的 operation_type 固定值
 */
export const BORN_OPERATION_TYPE = 'born' as const;

/**
 * born 事件条目：agent 初始化时写入的第一条行为日志
 */
export interface BornLogEntry extends ActionLogEntry {
  operation_type: typeof BORN_OPERATION_TYPE;
}

/**
 * 判断一条日志是否为 born 事件
 */
export function isBornEntry(entry: ActionLogEntry): entry is BornLogEntry {
  return entry.operation_type === BORN_OPERATION_TYPE;
}

// ─── 快照 ───────────────────────────────────────────────────

/**
 * Agent 行为快照
 *
 * 环境侧在每次检测时捕获，用于与上次快照比对。
 */
export interface AgentSnapshot {
  /** 被监控的 agent 标识 */
  agentId: string;
  /** 当前行行为日志条目列表（按 timestamp 升序） */
  logEntries: ActionLogEntry[];
  /** 快照捕获时间戳（Unix ms） */
  capturedAt: number;
}

// ─── 心跳配置 ───────────────────────────────────────────────

/**
 * 心跳检测配置
 */
export interface HeartbeatConfig {
  /** 检测间隔（毫秒），默认 5000 */
  checkIntervalMs?: number;
  /** 连续无变化判定阈值，默认 3 */
  deathThreshold?: number;
  /** 被监控的 agent 标识 */
  agentId: string;
}

/**
 * 心跳检测配置的解析后（含默认值）版本
 */
export interface ResolvedHeartbeatConfig {
  checkIntervalMs: number;
  deathThreshold: number;
  agentId: string;
}

// ─── 心跳状态 ───────────────────────────────────────────────

/**
 * Agent 心跳状态
 */
export enum HeartbeatStatus {
  /** 等待 born 事件 */
  WaitingForBorn = 'waiting_for_born',
  /** 正常存活 */
  Alive = 'alive',
  /** 已判定死亡 */
  Dead = 'dead',
}

/**
 * 心跳检测结果
 */
export interface HeartbeatCheckResult {
  /** 检测时间戳 */
  checkedAt: number;
  /** 当前状态 */
  status: HeartbeatStatus;
  /** 当前连续无变化次数 */
  noChangeCount: number;
  /** 当前快照的日志条目数 */
  logEntryCount: number;
  /** 与上次快照相比是否有变化 */
  hasChange: boolean;
}

// ─── 回调类型 ───────────────────────────────────────────────

/**
 * 死亡回调：agent 被判定死亡时触发
 */
export type DeathCallback = (
  agentId: string,
  result: HeartbeatCheckResult,
) => void;

/**
 * 存活回调：每次检测确认 agent 存活时触发
 */
export type AliveCallback = (
  agentId: string,
  result: HeartbeatCheckResult,
) => void;

// ─── 行为日志存储接口 ───────────────────────────────────────

/**
 * 行为日志存储接口（环境侧实现）
 *
 * Agent 无法调用写入方法——只有环境侧持有写入权限。
 */
export interface IActionLogStore {
  /** 追加一条行为日志（仅环境侧调用） */
  append(agentId: string, entry: ActionLogEntry): Promise<void>;
  /** 读取指定 agent 的全部行为日志 */
  read(agentId: string): Promise<ActionLogEntry[]>;
  /** 获取指定 agent 的行为日志条目数 */
  count(agentId: string): Promise<number>;
  /** 清除指定 agent 的全部行为日志 */
  clear(agentId: string): Promise<void>;
}

// ─── 快照提供者接口 ─────────────────────────────────────────

/**
 * 快照提供者接口
 *
 * 心跳监控器通过此接口获取 agent 的当前行为快照。
 */
export interface ISnapshotProvider {
  /** 捕获指定 agent 的当前行为快照 */
  capture(agentId: string): Promise<AgentSnapshot>;
}

// ─── 心跳监控器接口 ─────────────────────────────────────────

/**
 * 心跳监控器接口
 */
export interface IHeartbeatMonitor {
  /** 启动定时检测 */
  start(): void;
  /** 停止检测 */
  stop(): void;
  /** 注册死亡回调 */
  onDeath(callback: DeathCallback): void;
  /** 注册存活回调 */
  onAlive(callback: AliveCallback): void;
  /** 获取当前检测状态 */
  getStatus(): HeartbeatStatus;
  /** 获取当前连续无变化次数 */
  getNoChangeCount(): number;
}
