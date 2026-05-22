// ============================================================
// Environment 实现 — 不死 Agent 心跳检测原型
// ============================================================
//
// 设计要点：
//   - 行为日志写入权仅限 Environment 持有（appendLog 为 private）
//   - 外部只能通过 getLog() 获取只读副本，无法直接修改 behavior_log 数组
//   - born 事件仅在 registerAgent 时由环境写入
//   - 心跳检测：比对状态快照，连续 maxMissed 次无变化 → 判定死亡
//   - 不引入任何 agent 侧逻辑

import {
  type Agent,
  type AgentAction,
  type AgentStateSnapshot,
  type AgentStatus,
  type Environment,
  type HeartbeatConfig,
  type LogEntry,
  DEFAULT_HEARTBEAT_CONFIG,
} from "./types.js";

// ----- 内部数据结构 -----

/** Environment 内部对每个 agent 的追踪记录 */
interface AgentRecord {
  /** 行为日志 — 外部不可直接修改 */
  readonly log: LogEntry[];
  /** 当前存活状态 */
  status: AgentStatus;
  /** 上一次心跳检测时的 stateHash — 用于比对变化 */
  lastStateHash: string;
  /** 连续无变化计数 */
  missedCount: number;
}

// ----- Environment 实现 -----

export class EnvironmentImpl implements Environment {
  /** agent 注册表（id → Agent 引用） */
  private readonly _agents = new Map<string, Agent>();

  /** agent 追踪记录（id → AgentRecord） */
  private readonly _records = new Map<string, AgentRecord>();

  /** 心跳检测配置（只读） */
  public readonly config: HeartbeatConfig;

  constructor(config?: Partial<HeartbeatConfig>) {
    this.config = {
      maxMissed: config?.maxMissed ?? DEFAULT_HEARTBEAT_CONFIG.maxMissed,
      intervalMs: config?.intervalMs ?? DEFAULT_HEARTBEAT_CONFIG.intervalMs,
    };
  }

  // ---- 注册 ----

  /** 注册 agent，写入 born 事件；注册失败则 agent 视为死亡 */
  registerAgent(agent: Agent): void {
    const id = agent.id;
    if (this._records.has(id)) {
      // 已注册的 agent 不重复注册，保持现有状态
      return;
    }

    const now = Date.now();
    const bornEntry: LogEntry = {
      timestamp: now,
      operation_type: "born",
      impact_scope: `agent:${id}:initialization`,
    };

    const initialStateHash = this.computeStateHash([bornEntry]);

    this._agents.set(id, agent);
    this._records.set(id, {
      log: [bornEntry],
      status: "alive",
      lastStateHash: initialStateHash,
      missedCount: 0,
    });
  }

  // ---- 行为日志写入（唯一公开入口） ----

  /**
   * 执行 agent 行动，写入行为日志。
   * 这是外部产生行为日志条目的唯一入口；
   * born 以外的操作类型只能通过此方法写入。
   */
  act(agentId: string, action: AgentAction): void {
    const record = this._records.get(agentId);
    if (!record) {
      throw new Error(`[Environment] Agent "${agentId}" is not registered`);
    }
    if (record.status !== "alive") {
      throw new Error(
        `[Environment] Agent "${agentId}" is not alive (status: ${record.status})`
      );
    }
    this.appendLog(agentId, {
      timestamp: Date.now(),
      operation_type: action.operation_type,
      impact_scope: action.impact_scope,
    });
  }

  // ---- 行为日志读取（只读） ----

  /** 获取 agent 的行为日志（只读副本，外部无法修改内部数组） */
  getLog(agentId: string): ReadonlyArray<LogEntry> {
    const record = this._records.get(agentId);
    if (!record) return [];
    // 返回浅拷贝，防止外部通过引用修改内部数组
    return [...record.log];
  }

  // ---- 状态快照 ----

  /** 获取 agent 当前状态快照 */
  getSnapshot(agentId: string): AgentStateSnapshot | undefined {
    const record = this._records.get(agentId);
    if (!record) return undefined;
    return {
      agentId,
      status: record.status,
      stateHash: this.computeStateHash(record.log),
    };
  }

  // ---- 心跳检测 ----

  /**
   * 检测单个 agent 是否存活。
   *
   * 算法：
   *   1. 计算当前 stateHash
   *   2. 与上次检测时的 lastStateHash 比对
   *   3. 无变化 → missedCount++
   *      有变化 → missedCount 归零，更新 lastStateHash
   *   4. missedCount >= maxMissed → 判定死亡
   *
   * @returns 该 agent 是否仍存活
   */
  checkAlive(agentId: string): boolean {
    const record = this._records.get(agentId);
    if (!record) return false;
    if (record.status !== "alive") return false;

    const currentStateHash = this.computeStateHash(record.log);

    if (currentStateHash === record.lastStateHash) {
      // 状态无变化 — 递增 miss 计数
      record.missedCount++;
    } else {
      // 状态有变化 — 重置计数，更新基准
      record.missedCount = 0;
      record.lastStateHash = currentStateHash;
    }

    if (record.missedCount >= this.config.maxMissed) {
      record.status = "dead";
      return false;
    }

    return true;
  }

  /**
   * 执行一次全局心跳检测。
   * 遍历所有已注册且状态为 alive 的 agent，逐个执行 checkAlive。
   *
   * @returns 仍存活的 agent id 列表
   */
  heartbeat(): string[] {
    const alive: string[] = [];
    for (const [agentId, record] of this._records) {
      if (record.status === "alive") {
        if (this.checkAlive(agentId)) {
          alive.push(agentId);
        }
      }
    }
    return alive;
  }

  // ---- 内部方法 ----

  /**
   * 追加行为日志 — private，仅 Environment 内部调用。
   * 外部无法直接修改 behavior_log 数组。
   */
  private appendLog(agentId: string, entry: LogEntry): void {
    const record = this._records.get(agentId);
    if (!record) return;
    record.log.push(entry);
  }

  /**
   * 基于行为日志计算状态哈希。
   *
   * 策略：使用日志长度 + 最后一条日志的时间戳 + 操作类型
   * 生成确定性摘要，足以检测"是否有新行为产生"。
   * 由于行为日志写入权仅在 Environment 侧，
   * agent 无法伪造此哈希值。
   */
  private computeStateHash(log: LogEntry[]): string {
    if (log.length === 0) return "";
    const last = log[log.length - 1];
    return `${log.length}:${last.timestamp}:${last.operation_type}`;
  }
}
