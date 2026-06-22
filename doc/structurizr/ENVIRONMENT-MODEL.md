# 环境模型（ADL 权威）

> **English:** Pluggable **environment sensors** + **time-aware journal** + **derived metrics** replace the flat `ResourceSnapshot` of [`RESOURCE-AWARENESS-AUTONOMY.md`](./RESOURCE-AWARENESS-AUTONOMY.md). The strategy layer ([`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md)) and `autonomyJudge` consume `EnvironmentSnapshot` instead of poking individual data sources.

> 与 `workspace.dsl` 视图 **`12-L3-Outer-Environment`** 同步。

## 1. 动机

[`RESOURCE-AWARENESS-AUTONOMY.md`](./RESOURCE-AWARENESS-AUTONOMY.md) §5 的 `ResourceSnapshot` 是 **扁平结构** + **无记忆**：

| 缺陷 | 后果 |
|------|------|
| 每加一个观测维度（mem9 健康 / 用户活跃度 / 时段语义 …）都要改 schema、改 `autonomyJudge`、改 `autonomyTaskDispatcher` | 扩展不动；判定逻辑与数据源紧耦合 |
| 每 tick 仅有「现在」，没有「最近一小时怎么变」 | 战略反思层（[`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md)）只能看瞬时；无法识别「token 速率上行 30%」「AWAITING 已连续过载 47 分钟」等趋势 |
| 派生指标（rate / streak / zScore）散落在判定方 | 不同消费方各自重算；难以统一阈值与去抖 |

**目标**：把 `resourceProbe` 拆成 **传感器注册表 + 环境日志 + 派生指标** 三件套，让加 sensor = 加一个 handler，让"环境感知"变成"有记忆的环境模型"。

## 2. 与既有模块的边界

| 既有模块 | 关系 |
|----------|------|
| `resourceProbe`（P0） | **被 `environmentSensorRegistry` 替代**；P0→P1 过渡期 facade，不双源真相 |
| `llmUsageTracker` / `llmUsageJournal` | **被 `llmUsageSensor` 包装**（sensor 只读，不重复造数据） |
| `innerBrainRegistry` / `threadOrchestrator` / `participation-state` | sensor 的**只读输入**（不写） |
| `autonomyJudge` | 由 `ResourceSnapshot` → 改读 `EnvironmentSnapshot.facets`；hardGates 可基于派生指标。**实现路径**：`outer/environment/autonomy-judge.ts`（2026-06-07 自 outer/ 迁入） |
| `autonomyPolicyStore` | 同上，路径 `outer/environment/autonomy-policy-store.ts` |
| `strategyPlanner` | **已删除**（2026-06-07）；KPI 编排见 [`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md) |
| `kpiManager` / `kpiAdvancer` | 读 `EnvironmentSnapshot.facets` + `evaluateKpiSpawnCapacity` 决定 spawn（非 ResourceSnapshot 适配） |

**勿混**：sensor **不替代** `kpiRegistry`、`participationPolicy`、`memoryBlockStore` 等业务状态机；它们仍是真相源，sensor 只暴露**派生量**（如 `kpiVelocitySensor` 从 registry 算出"近 N burst 平均时长"）。

## 3. L3 模块划分（三件套）

| 模块 ID | 职责 | 规划路径 | In → Out |
|---------|------|----------|----------|
| **environmentSensorRegistry** | sensor 注册 / tick 调度 / 扇入 facets | `outer/environment/sensor-registry.ts` + `environment-sensors.ts` | sensors[].read() → `EnvironmentSnapshot` |
| **environmentJournal** | ring buffer（内存）+ events.jsonl + hourly.jsonl + current.json | `outer/environment/journal.ts` | snapshot → 时序留存 + retention |
| **environmentChangeDetector** | diff + 派生指标 + 显著事件触发 | `outer/environment/change-detector.ts` | prev/next snapshot → events[] + derived |

**Sensor 不是独立 component**（与 `outerToolExecutor` / autonomy task handlers 同构），是 `environmentSensorRegistry` 内的 handler 数组；新增维度 = 新增 handler，不动 ADL 组件图。

## 4. Sensor 契约

```typescript
interface EnvironmentSensor<TFacet = unknown> {
  /** 稳定 id：snapshot.facets[id]、journal 序列 key、判定/策略引用 key */
  id: string;
  label: string;
  /** 给 STRATEGY-REFLECT LLM 看：「这条 facet 表示什么、什么时候重要」 */
  description: string;

  cadence: 'every_tick' | 'rate_limited' | 'on_event';
  cadenceConfig?: { minIntervalMs?: number; events?: string[] };

  /** 同步读取；禁 LLM、禁阻塞 IO；IO bound 必须后台轮询 + 缓存，read() 只读缓存 */
  read(ctx: SensorContext): Promise<TFacet>;

  /** 关键字段比较，避免噪声（默认 deep equal） */
  hasChanged?(prev: TFacet, next: TFacet): boolean;

  /** 显著事件检测（阈值穿越 / 状态变更 / 首次见到 / 失联） */
  detectEvents?(prev: TFacet | null, next: TFacet, history: FacetSeries<TFacet>): EnvironmentEvent[];

  /** 派生量（rate / streak / delta / zScore），由 changeDetector 调，deterministic */
  derive?(history: FacetSeries<TFacet>): Record<string, number>;
}
```

`SensorContext` 提供只读依赖（`innerBrainRegistry.list`、`llmUsageJournal.summarize`、`process.memoryUsage` 等），sensor **不能直 import 业务模块**——通过 ctx 注入。

## 5. EnvironmentSnapshot

```typescript
interface EnvironmentSnapshot {
  capturedAt: string;            // ISO
  agentId: string;
  facets: Record<string, FacetEnvelope>;
}

interface FacetEnvelope<T = unknown> {
  sensorId: string;
  capturedAt: string;
  data: T;                       // sensor 读出的原始 facet
  derived: Record<string, number>;   // 由 changeDetector 注入
  staleness?: 'fresh' | 'cached' | 'stale';   // IO bound sensor 用
}
```

**消费**：判定方读 `facets[id].data` 与 `facets[id].derived`，**不直接调 sensor.read**。

## 6. 三层时间尺度（环境日志）

| 层 | 介质 | 保留 | 写时机 | 读者 |
|----|------|------|--------|------|
| **Tick ring buffer** | 内存 | 最近 N（默认 64 tick） | 每 tick | `autonomyJudge`、`environmentChangeDetector` |
| **当前快照** | `data/environment/current.json` | 覆盖 | 每 tick | Dashboard 实时面板 |
| **显著事件** | `data/environment/events.jsonl` | 永久（按月轮转） | 事件驱动（detectEvents 命中） | `strategyPlanner.reflect` |
| **小时聚合** | `data/environment/hourly.jsonl` | 永久 | 每整点 cron-like | `strategyPlanner.reflect`（长程） |

**禁止**把每 tick 的 ring buffer 全量落盘——量大且无意义；落盘只走"事件 + 聚合"两条稀疏通道。

```typescript
interface EnvironmentEvent {
  at: string;
  sensorId: string;
  kind: 'threshold_crossed' | 'state_change' | 'first_seen' | 'lost' | 'derivative_spike';
  field: string;                 // facet 内具体字段（如 'awaiting' / 'tokensRatePerMin'）
  before?: unknown;
  after?: unknown;
  note: string;                  // 给 LLM 看的人话
  /** 被 strategyPlanner.reflect 消费过的事件标记，避免重复入 prompt */
  consumedByStrategyAt?: string;
}

interface HourlyAggregate {
  hour: string;                  // ISO YYYY-MM-DDTHH:00:00Z
  sensorId: string;
  field: string;
  count: number;
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}
```

## 7. 派生指标规范

| 派生量 | 含义 | 命名 |
|--------|------|------|
| **rate** | 单位时间内变化量 | `<field>_ratePerMin` |
| **delta** | 与 N 时间前的差 | `<field>_delta_<window>`（如 `_delta_1h`） |
| **streak** | 连续超阈值的持续时间 | `<field>_streakMin` |
| **zScore** | 相对历史均值的偏离 | `<field>_zScore_<window>` |
| **growth** | 计数增量 | `<field>_growth_<window>` |

**约束**：

- deterministic（不依赖 random / LLM）
- O(1) over ring buffer（环形累加器）
- **warmUp**：样本数 < N 时返回 `null`，不进 prompt（防小样本说谎）
- **滞回（hysteresis）**：上行阈值 X，下行阈值 X×0.8，避免抖动反复触发事件

## 8. 内置 sensor 列表（P0 → P3）

| Sensor ID | 阶段 | 数据源 | 关键 derived |
|-----------|------|--------|--------------|
| `innerBrains` | P0 | `innerBrainRegistry` | `awaiting_streakMin` / `awaiting_growth1h` |
| `llmUsage` | P0 | `llmUsageJournal` | `tokensRatePerMin` / `tokensRatePerMin_delta_1h` |
| `inbound` | P0 | `threadOrchestrator` | `queueDepth_streakMin` |
| `im` | P0 | `participation-state` | `proactiveCount5min` |
| `process` | P0 | `process` Node API | `heap_zScore_24h` |
| `time` | P1 | 墙钟 + agent TZ | `isQuietHours` / `dayOfWeekKind`（休息日 / 工作日） |
| `mem9Health` | P2 | mem9-client 后台 ping | `staleness` / `errRate1h` |
| `drive9Health` | P2 | drive9-client 后台 ping | `staleness` / `errRate1h` |
| `kpiVelocity` | P2 | `kpiRegistry.burstRunHistory` | `avgBurstMs_perKpi` / `successRate1d` |
| `costRate` | P3 | `llmUsageJournal` × 模型计价 | `usdPerHour` |
| `userResponsiveness` | P3 | `awaitingInboundResolver` 历史 | `humanReplyP50_min` |

新 sensor 治理：每个 PR 必须给 `description`（LLM-readable 一句话）+ 至少一个 `derive` 量 + `retention 影响评估`。

## 9. 与战略层 / 判定层的接口

### 9.1 `autonomyJudge`

```typescript
hardGates: {
  // 既有（瞬时阈值）
  maxRunningInnerBrains: 1,
  maxLlmInFlight: 2,

  // 新（基于派生量；P3 起）
  maxTokenRatePerMin?: number;
  maxAwaitingStreakMin?: number;
  maxCostPerHourUsd?: number;
  ignoreDispatchIf_time_isQuietHours?: boolean;
}
```

P0 仍是瞬时硬闸门；环境模型上线后 schema 留口子，按需启用。

### 9.2 `strategyPlanner.reflect`

```typescript
interface StrategyReflectInput {
  envCurrent: EnvironmentSnapshot;
  envEvents: EnvironmentEvent[];          // 仅未消费（consumedByStrategyAt 为空）
  envHourly: Record<string, HourlyAggregate[]>;   // 最近 24h / 7d 聚合
  // + KPI / burstRunHistory / lastStrategy …（见 STRATEGY-PLANNING-LAYER.md §4）
}
```

reflect 完成后由 `strategyPlanner` 把读过的事件标 `consumedByStrategyAt`，下一轮不再塞入 prompt。

## 10. 持久化路径

```text
DATA_ROOT/environment/
  current.json                # 最新 EnvironmentSnapshot（覆盖）
  events.jsonl                # 显著事件（append；按月轮转：events-YYYY-MM.jsonl）
  hourly.jsonl                # 小时聚合（append；按年轮转）
```

`events.jsonl` 单行 ≤ 1KB（before/after 截断为摘要）；`hourly.jsonl` 单行固定字段。

## 11. 禁止 / 守门

| 禁止 | 守门 |
|------|------|
| sensor.read() 调 LLM | code review + lint：sensor 不 import `llm/raw` |
| sensor.read() 阻塞 IO | IO bound sensor 必须后台 worker + 缓存 + `staleness` 标记 |
| 派生指标依赖 random / LLM | 单测 deterministic（同输入 → 同输出） |
| ring buffer 无界增长 | 注册表层硬上限 `MAX_RING_SIZE` |
| 直接落盘每 tick | 只允许 `current.json` 覆盖 + 事件/聚合稀疏写 |
| sensor 直 import 业务模块 | 必须通过 `SensorContext` 注入 |

## 12. 实施分期

| 阶段 | 交付 | 行为变化 |
|------|------|----------|
| **P0 ✅** | sensor registry + 5 个内置 sensor（innerBrains/llmUsage/inbound/im/process）+ ring buffer 内存 + `current.json` | 替换 `resourceProbe`：`autonomyPipeline` 经 `getSharedEnvironment` 采集 → `toResourceSnapshot` 适配回 `ResourceSnapshot` 喂旧 judge/dispatch，**行为等价**（旧两条 judge/integration 测的 pre-existing 失败与本改动无关） |
| **P1 🟡** | `events.jsonl`（按月轮转）+ `hourly.jsonl`（`aggregateHour` 纯函数）+ 基础 derive（rate/delta/streak）+ `timeSensor` | 已落：events 月轮转 + 未消费查询 + markConsumed + derive；`hourly.jsonl` 提供 append/read API，定点 cron 聚合接线待战略层一并接入 |
| **P2** | `mem9Health` / `drive9Health` / `kpiVelocity` sensor + 异常检测（zScore）+ Dashboard 环境面板 | 真正的"环境感知" |
| **P3** | rate/streak 类 hardGate；`costRate` / `userResponsiveness` sensor | judge 有时序闸门 |

## 13. Structurizr 视图

- **`12-L3-Outer-Environment`**：`environmentSensorRegistry` ← 各 sensor handler；→ `environmentChangeDetector` → `environmentJournal`（存）+ 消费方（`autonomyJudge` / `strategyPlanner` / Dashboard）

## 14. 测试策略

| 层级 | 范围 |
|------|------|
| unit | `environment-sensor-registry.test.ts`（mock sensors → snapshot 形态）；`environment-change-detector.test.ts`（hysteresis、warmUp、derived 计算）；`environment-journal.test.ts`（rotation、retention、append append-only） |
| integration | `environmentSensorRegistry.component.integration.test.ts`：注册 5 个内置 sensor → tick → snapshot facets 完整；`environmentJournal.component.integration.test.ts`：事件去重消费 + hourly aggregation |
| prompt | — |

测试与组件映射见 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)。

## 15. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-01 | 初版 ADL：sensor registry + journal + changeDetector；替代 `resourceProbe` 扁平 snapshot |
| 2026-06-06 | P0 落地：`outer/environment/`（types/sensors/change-detector/journal/sensor-registry/facade）；6 个内置 sensor（5 P0 + `timeSensor`）；`autonomyPipeline` 经 `getSharedEnvironment`+`toResourceSnapshot` 行为等价接管 `resourceProbe`；3 套单测（registry/journal/changeDetector，24 例）全绿。P1 events/derive 一并落地，hourly cron 接线留待战略层 |
