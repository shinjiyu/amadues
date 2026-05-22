# 不死 Agent 心跳检测原型 — 接口说明文档

> 测试验证：20 tests passed, 0 failed（覆盖正常存活、超时终止、born 事件、防伪造四类场景）

---

## 1. 核心类型

### 1.1 OperationType

```
type OperationType = "born" | "act" | "respond" | "communicate"
```

行为操作类型枚举。`born` 仅由 Environment 在注册时写入，Agent 不可使用。

### 1.2 LogEntry

行为日志条目 — 只有 Environment 侧能写入。

| 字段 | 类型 | 说明 |
|------|------|------|
| `timestamp` | `number` | 毫秒精度时间戳 |
| `operation_type` | `OperationType` | 操作类型 |
| `impact_scope` | `string` | 描述该行为的外部可观测影响 |

### 1.3 AgentStatus

```
type AgentStatus = "alive" | "dead" | "unborn"
```

| 值 | 语义 |
|----|------|
| `"unborn"` | 尚未向 Environment 注册 |
| `"alive"` | 已注册且心跳正常 |
| `"dead"` | 连续无行为，已被心跳检测判定死亡 |

### 1.4 AgentStateSnapshot

Environment 侧维护的 Agent 状态快照，用于心跳比对。

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | `string` | agent 唯一标识 |
| `status` | `AgentStatus` | 当前存活状态 |
| `stateHash` | `string` | 内部状态摘要（由行为日志计算，Agent 无法伪造） |

### 1.5 AgentPerception

Agent 通过 `perceive()` 感知到的自身信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | `string` | 自身标识 |
| `status` | `AgentStatus` | 当前状态（来源：Environment 快照） |

### 1.6 AgentAction

Agent 通过 `act()` 提交的行动请求。

| 字段 | 类型 | 说明 |
|------|------|------|
| `operation_type` | `Exclude<OperationType, "born">` | 操作类型（**编译期排除 `born`**） |
| `impact_scope` | `string` | 影响范围描述 |

### 1.7 HeartbeatConfig

心跳检测配置。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxMissed` | `number` | `3` | 连续无变化次数阈值，达到即判定死亡 |
| `intervalMs` | `number` | `1000` | 心跳检测间隔（毫秒） |

---

## 2. Environment 接口

```
interface Environment {
  readonly config: HeartbeatConfig
  registerAgent(agent: Agent): void
  act(agentId: string, action: AgentAction): void
  getLog(agentId: string): ReadonlyArray<LogEntry>
  getSnapshot(agentId: string): AgentStateSnapshot | undefined
  heartbeat(): string[]
}
```

实现类：`EnvironmentImpl`，构造函数接受可选的 `Partial<HeartbeatConfig>`。

### 2.1 registerAgent(agent: Agent): void

注册 Agent 并写入 `born` 事件。

- 将 agent 添加到注册表
- 写入 `born` 事件作为行为日志第一条
- 设置初始状态为 `"alive"`，初始化 `missedCount = 0`
- **幂等**：若 agent 已注册，重复调用不产生副作用

### 2.2 act(agentId: string, action: AgentAction): void

执行 Agent 行动 — **行为日志的唯一公开写入入口**。

- 验证 agent 已注册且状态为 `"alive"`，否则抛出错误
- 追加行为日志条目（timestamp 取当前时间，operation_type 和 impact_scope 来自参数）
- born 以外的操作类型只能通过此方法写入

**错误抛出**：
- agent 未注册 → `Error: Agent "<id>" is not registered`
- agent 非存活 → `Error: Agent "<id>" is not alive (status: <status>)`

### 2.3 getLog(agentId: string): ReadonlyArray<LogEntry>

获取 agent 的行为日志（只读）。

- 返回浅拷贝数组，外部无法通过引用修改内部数组结构
- agent 未注册时返回空数组 `[]`
- **注意**：内部条目对象仍为引用，外部理论上可修改条目属性；这是当前实现的已知边界

### 2.4 getSnapshot(agentId: string): AgentStateSnapshot | undefined

获取 agent 当前状态快照。

- agent 未注册时返回 `undefined`
- `stateHash` 由 `computeStateHash()` 计算，基于日志长度 + 最后一条日志的时间戳 + 操作类型

### 2.5 heartbeat(): string[]

执行一次全局心跳检测，返回仍存活的 agent id 列表。

- 遍历所有状态为 `"alive"` 的 agent，逐个调用 `checkAlive()`
- 被判定死亡的 agent 状态变为 `"dead"`，后续不再参与检测

---

## 3. Agent 接口

```
interface Agent {
  readonly id: string
  perceive(): AgentPerception
  act(action: AgentAction): void
}
```

实现类：`AgentImpl`，构造函数签名为 `(id: string, env: Environment)`。

### 3.1 perceive(): AgentPerception

感知自身状态 — 从 Environment 侧获取。

- 不缓存可变状态，每次调用均从 Environment 快照读取
- 未注册时返回 `{ agentId, status: "unborn" }`
- 已注册时返回 Environment 侧的实时状态

### 3.2 act(action: AgentAction): void

请求执行行动 — 委托给 `Environment.act()`。

- Agent 不直接写入行为日志，所有副作用由 Environment 侧执行
- 若 agent 未注册或已死亡，Environment.act() 抛出错误

### 3.3 initializeBorn(): void（AgentImpl 额外方法）

向 Environment 注册自己，触发 `born` 事件写入。

- 构造函数不自动注册，需显式调用
- 内部调用 `Environment.registerAgent(this)`
- 重复调用安全（Environment 侧去重）

---

## 4. 死亡判定规则

心跳检测由 `Environment.heartbeat()` 驱动，核心算法在 `checkAlive(agentId)` 中：

1. 计算当前 `stateHash`（基于行为日志的确定性摘要）
2. 与上次检测时的 `lastStateHash` 比对
3. **无变化** → `missedCount++`
4. **有变化** → `missedCount = 0`，更新 `lastStateHash`
5. `missedCount >= config.maxMissed` → 状态置为 `"dead"`

**关键约束**：
- `stateHash` 由 Environment 内部 `computeStateHash()` 计算，Agent 无法伪造
- 只要 Agent 有新行为产生（`act()` 写入新日志条目），`stateHash` 必然变化，`missedCount` 归零
- 死亡不可逆：一旦状态变为 `"dead"`，不再参与后续心跳检测

---

## 5. 防伪造机制

| 层面 | 机制 | 说明 |
|------|------|------|
| **born 事件** | `Exclude<OperationType, "born">` | AgentAction 的 operation_type 类型编译期排除 `"born"`，Agent 无法自行写入 born 事件 |
| **日志写入权** | `appendLog()` 为 private | 行为日志的唯一内部写入方法，外部不可调用；`act()` 是唯一公开入口 |
| **日志读取** | `getLog()` 返回浅拷贝 | 返回 `[...record.log]`，外部无法通过引用修改内部数组 |
| **状态感知** | `perceive()` 从 Environment 获取 | Agent 不持有可被伪造的内部状态，每次感知均从 Environment 快照读取 |
| **状态哈希** | `computeStateHash()` 为 private | 哈希由 Environment 独占计算，Agent 无法篡改比对基准 |

**已知边界**：
- `getLog()` 返回浅拷贝 — 数组结构受保护，但条目对象为引用，外部可通过引用修改条目属性
- `AgentAction.operation_type` 的 `Exclude` 为编译期类型防护 — 通过 `as any` 可绕过，运行时 `act()` 不做额外过滤
