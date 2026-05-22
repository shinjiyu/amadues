// ============================================================
// Agent 实现 — 不死 Agent 心跳检测原型
// ============================================================
//
// 设计要点：
//   - Agent 不能直接操作 behavior_log，所有副作用必须通过 Environment.act() 产生
//   - born 事件由 Environment.registerAgent() 写入，Agent 通过 initializeBorn() 触发
//   - perceive() 从 Environment 获取自身状态快照，不持有可被伪造的内部状态
//   - AgentAction.operation_type 使用 Exclude<OperationType, "born">，
//     类型层面阻止 agent 自行写入 born 事件（防伪造）
//   - Agent 只持有 Environment 引用和自身 id，不缓存可变状态

import {
  type Agent as AgentInterface,
  type AgentAction,
  type AgentPerception,
  type AgentStatus,
  type Environment,
} from "./types.js";

// ----- Agent 实现 -----

/**
 * Agent 实现 — 感知与行动
 *
 * 职责：
 *   - perceive(): 感知自身状态（从 Environment 侧获取）
 *   - act(action): 通过 Environment 产生外部可观测副作用
 *   - initializeBorn(): 向 Environment 注册自己，触发 born 事件写入
 *
 * 防伪造保证：
 *   - Agent 不持有 behavior_log 引用，无法直接写入日志
 *   - act() 委托给 Environment.act()，由 Environment 侧执行写入
 *   - AgentAction.operation_type 为 Exclude<OperationType, "born">，
 *     编译期阻止 agent 伪造 born 事件
 *   - perceive() 返回的状态来自 Environment 的快照，agent 无法篡改
 */
export class AgentImpl implements AgentInterface {
  /** agent 唯一标识 */
  public readonly id: string;

  /** Environment 引用 — agent 通过此引用产生副作用和感知状态 */
  private readonly _env: Environment;

  /**
   * 创建 Agent 实例。
   *
   * 注意：构造函数不会自动注册到 Environment。
   * 必须显式调用 initializeBorn() 完成注册，才会写入 born 事件。
   *
   * @param id - agent 唯一标识
   * @param env - Environment 引用
   */
  constructor(id: string, env: Environment) {
    this.id = id;
    this._env = env;
  }

  /**
   * 初始化 born 事件 — 向 Environment 注册自己。
   *
   * Environment.registerAgent() 会：
   *   1. 将 agent 添加到注册表
   *   2. 写入 born 事件作为行为日志的第一个条目
   *   3. 设置初始状态为 "alive"
   *
   * 如果 agent 已注册，重复调用不会产生副作用（Environment 侧去重）。
   */
  initializeBorn(): void {
    this._env.registerAgent(this);
  }

  /**
   * 感知自身状态 — 从 Environment 侧获取。
   *
   * Agent 不缓存可变状态，每次调用都从 Environment 获取最新快照，
   * 确保感知到的状态与环境侧一致，无法被 agent 伪造。
   *
   * @returns Agent 感知到的自身信息；若未注册则返回 unborn 状态
   */
  perceive(): AgentPerception {
    const snapshot = this._env.getSnapshot(this.id);
    if (!snapshot) {
      // 未注册到 Environment，状态为 unborn
      return {
        agentId: this.id,
        status: "unborn" as AgentStatus,
      };
    }
    return {
      agentId: snapshot.agentId,
      status: snapshot.status,
    };
  }

  /**
   * 请求执行行动 — 通过 Environment 产生外部可观测副作用。
   *
   * Agent 不能直接写入行为日志，必须通过此方法委托给
   * Environment.act() 执行。Environment 侧负责：
   *   - 验证 agent 是否已注册且存活
   *   - 写入行为日志条目
   *   - 更新状态哈希（供心跳检测比对）
   *
   * 防伪造：
   *   - AgentAction.operation_type 类型为 Exclude<OperationType, "born">，
   *     编译期阻止传入 "born"
   *   - 日志写入完全由 Environment 侧控制，Agent 无法绕过
   *
   * @param action - 行动请求（不含 born 类型）
   * @throws 如果 agent 未注册或已死亡，Environment.act() 会抛出错误
   */
  act(action: AgentAction): void {
    this._env.act(this.id, action);
  }
}
