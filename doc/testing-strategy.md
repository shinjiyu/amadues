# 测试策略（Testing Strategy）

> **地位**：本文是测试工程的"宪法"。所有后续测试代码、模块重构（为可测性）必须按本文落地；
> 任何新模块在合并前，先在本文表格里登记自己的测试入口。
>
> **撰写日期**：2026-05-16 · **状态**：设计已拍板（待开始 B 阶段）
>
> **指导原则**（与 `agent-data-state-machine.md` 同源）：
> 1. **数据即本体**：测试基于磁盘/内存数据状态断言，不依赖进程内变量。
> 2. **协议即契约**：跨模块的协议（pendings.json、COMPLETE 事件、reply.v1 等）就是模块测试的边界。
> 3. **设计先行**：先有标准，再补测试；不要"边写边猜"。

---

## 0. TL;DR

| 项 | 决定 |
|----|------|
| 框架 | **Vitest 2.1.x**（已既成事实，统一升级） |
| 分层 | 单元 / 模块 / **Prompt 效果** / 装配 四层 |
| 命名 | `*.test.ts`（单元）· `*.integration.test.ts`（模块）· `*.prompt.test.ts`（**真实 LLM**）· `*.live.test.ts`（默认 skip） |
| LLM 测试原则 | **原则上优先真实 LLM**：测 prompt 效果必须真实；纯解析 / 错误兜底等才用 FakeLLM（§S3 翻转，2026-05-17 拍板） |
| 缺 LLM key 行为 | **prompt 套件直接 fail**（不静默 skip），由 `requireLlmEnvForPrompt()` 抛错 |
| 强制标准 | 7 条（见 §3） |
| 实施路线 | A 设计 → B 立标准 → C 重构 4 文件 → D 单元 → E 模块 → F 装配 |
| ESLint 强制 import 边界 | 暂缓（个人项目，后补） |

---

## 1. 现状与问题

### 1.1 现有测试一览（粗扫）

| 包 | `*.test.ts` 数 | 备注 |
|----|----------------|------|
| `@utlra/chat-ir` | 5 | mention / seen / reply-utils / ids / identity-registry |
| `@utlra/core` | 2 | workspace / repository |
| `@utlra/webchat-protocol` | 1 | ids |
| `@utlra/webchat-bridge` | 2 | reply-render / thread-mapper |
| `@utlra/chat-server` | 2 | e2e / parts-builder |
| `@utlra/server` | 21 | 散落；外脑 / 内脑 / mem9 / drive9 / llm 都各有几份 |

### 1.2 主要痛点

1. **散点测试，无模块契约**：单测只覆盖工具函数，模块对外契约（如"内脑跑一轮"、"外脑判定一次入站"）无人守。
2. **业务函数直接读 `process.env`**：60+ 处。测试要写 `process.env.X = '0'`，并发不安全。
3. **LLM 调用三条并行路径**：`LLMAdapter` / `inner-llm-step` / `llmRawChatCompletion`，无法在一个 mock 里全替换。
4. **测试与真服务耦合**：`mem9-client.test.ts` 连真 mem9，单测一跑就卡 90s+。
5. **测试框架已统一为 Vitest，但版本、配置不一致**：`prototypes/heartbeat` 还在 1.6；server 包没有 integration 配置约定。

---

## 2. 框架选型：Vitest（锁定）

### 2.1 为什么

- 7 个 package 已经全用 Vitest，且都在 2.1.x。
- ESM/TS 原生友好；与现有 `tsx` 工具链零摩擦。
- `vi.fn()` / `vi.mock()` API 稳定；并发执行默认开启，符合本仓库"无全局可变状态"目标。

### 2.2 版本约定

```
vitest        ^2.1.9   (统一升到 server 包当前版本)
@vitest/ui    可选，本地用
```

`prototypes/heartbeat` 是原型代码，可保留 1.6，但**新原型必须 ^2.1.9**。

### 2.3 配置约定

每个 package 必须有：

| 文件 | 用途 | 必须 |
|------|------|------|
| `vitest.config.ts` | 单元 | ✅ |
| `vitest.integration.config.ts` | 模块/集成 | 仅 server 包必需，其它按需 |

公共约定（写在 `vitest.config.ts`）：

```ts
{
  environment: 'node',
  testTimeout: 5_000,      // 单测超 5s = 可疑
  hookTimeout: 5_000,
  include: ['src/**/*.test.ts'],
  exclude: [
    'src/**/*.integration.test.ts',
    'src/**/*.live.test.ts',
  ],
}
```

模块/集成配置（`vitest.integration.config.ts`）：

```ts
{
  environment: 'node',
  testTimeout: 30_000,
  include: ['src/**/*.integration.test.ts'],
}
```

### 2.4 命名约定（四层）

| 后缀 | 含义 | 是否默认运行 | 依赖 |
|------|------|---------------|------|
| `*.test.ts` | 单元：单文件 / 单函数 / 纯逻辑 | ✅ | 无网络 / 无子进程；涉及 LLM **仅**用 FakeLLM 测错误兜底等不涉及 prompt 效果的路径 |
| `*.integration.test.ts` | 模块：多文件协作，临时 workDir | ✅（独立 config） | 可写临时盘；LLM 按 §S3 决策 |
| `*.prompt.test.ts` | **Prompt 效果**：测 prompt 设计能否让真实 LLM 产出预期格式 / 类别 | ✅（独立 config，2026-05-17 新增） | **真实 LLM**；vitest config 自动 dotenv 加载根 `.env`；缺 key → fail |
| `*.live.test.ts` | 真机：打真 API（mem9、drive9 等真服务） | ❌ 默认 skip | 需 `VITEST_LIVE=1` |

**判别 prompt vs unit 的指南**：

| 测试目的 | 文件后缀 |
|---------|----------|
| 测「parseControlFlag 能识别 'CONTROL: REPLAN'」 | `.test.ts`（纯函数） |
| 测「prompt 能让 LLM 写出可被 parseControlFlag 识别的 CONTROL flag」 | `.prompt.test.ts`（prompt 效果） |
| 测「LLM 抛错时业务 catch 返回 silent」 | `.test.ts`（错误兜底，用 FakeLLM） |
| 测「participationSpeakLlm 系统提示能让 LLM 倾向于在私事场景输出 SILENT」 | `.prompt.test.ts`（prompt 效果） |
| 测「`shouldReplySyncRules` 同步规则」 | `.test.ts`（纯函数） |

---

## 3. 可测性标准（**新代码强制；老代码渐进改**）

### S1. 依赖显式注入（DI）

**红线**：业务函数禁止直接读 `process.env` / `Date.now()` / 算路径常量。

约定形式：

```ts
// ❌ 旧式：函数内部直接读
export function resolveProactiveLevel(): number {
  return Number(process.env['UTLRA_OUTER_PROACTIVE_LEVEL'] ?? 2);
}

// ✅ 新式：每个模块一个 loadConfig，调用方注入
export interface InboundConfig {
  proactiveLevel: number;
  cooldownMs: number;
  maxProactivePer5Min: number;
  useLlmForParticipation: boolean;
}

export function loadInboundConfigFromEnv(env = process.env): InboundConfig {
  // 唯一允许碰 env 的地方
}

export function shouldReplySyncRules(
  params: { ... },
  config: InboundConfig,
): ShouldReplySyncResult { ... }
```

**改造范围**：业务模块的「读 env」全部收敛到 `loadConfigFromEnv()` 或工厂入参；
`index.ts` 启动时 load 一次，注入下去。

### S2. 纯逻辑层与副作用层分离

**红线**：每个模块至少有一个**纯函数入口**作为测试抓手。

举例：

| 模块 | 纯函数（单元测） | 副作用壳（模块测） |
|------|------------------|----------------------|
| 入站策略 | `shouldReplySyncRules` | `decideOuterShouldReply`（调 LLM、写频控） |
| KPI hook | `shouldAutoAchieveKpi` / `shouldRecordKpiIdle` | `processBurstExitForKpi`（写 registry） |
| 完成报告 | `buildCompletionReport` | `notifyInnerBrainTaskComplete`（IM 出站） |
| Pendings | `listActivePendings`（纯读） | `addPending` / `resolvePending`（写盘） |

### S3. LLM 通过统一 Adapter，**原则上优先真实 LLM**

**红线**：所有 LLM 调用必须经过 `LLMAdapter` 或显式注入的回调（让测试**可以**替换）；
**但**测试里**是否真的替换**，按下述原则：

#### 决策表（2026-05-17 翻转）

| 测试目的 | 用什么 | 文件后缀 |
|---------|--------|----------|
| 测 prompt 内容能否让 LLM 产出符合预期的回应（SPEAK/SILENT 判定、Attributor 写出可解析的 CONTROL flag、Decomposer 产合格 milestones） | **真实 LLM** | `*.prompt.test.ts` |
| 测纯解析层（parseControlFlag / parseMilestonesFromContent / shouldReplySyncRules 等） | 不调 LLM，纯函数 | `*.test.ts` |
| 测错误兜底（LLM 抛错时业务 catch / 超时降级） | **FakeLLM**（不关心 prompt 效果，只关心抛错行为） | `*.test.ts` |
| 测业务编排（一次 burst 走 DECOMPOSE → EXECUTE → ATTRIBUTE → COMPLETE 状态机） | **真实 LLM**（默认）+ FakeLLM（边界 / 异常路径） | `*.integration.test.ts` |

#### 实施要点

- **缺 LLM key 时直接 fail，不静默 skip**：由 `src/testing/require-llm.ts::requireLlmEnvForPrompt()` 抛错。
  prompt 测试文件**顶层**调用 `const env = requireLlmEnvForPrompt();`，缺 key 则该文件**整体 fail**。
- **断言策略**：用语义匹配而非精确字符串。
  `expect(text.toUpperCase()).toMatch(/SPEAK|SILENT/)` ✓
  `expect(text).toBe('SPEAK')` ✗（LLM 输出有抖动）
- **软警告**：在「明显 SILENT」场景里若返回 SPEAK，用 `console.warn` 记录但**不 fail**——分类正确性是 LLM 能力问题，
  prompt test 只硬断「格式遵守」（产出可被业务侧解析），「类别正确」靠人工跑 `test:prompt` 时眼看 stdout。
- **maxTokens 必须给 thinking 留 budget**：GLM 等强制 thinking 模型即便传 `thinking: 'disabled'` 也不一定生效；
  二分类调用的 maxTokens 至少 ≥1024，否则 thinking 吃光 budget → content=null → provider 抛 empty content。

#### LLM 路径现状

| 当前路径 | 谁在用 | 状态 |
|----------|--------|------|
| `LLMAdapter` | 内脑 controller 各阶段 | ✅ 保留 |
| `inner-llm-step` | 外脑部分工具 | ✅ env 解析层已收口为 `loadInnerLlmEnvFromProcess` |
| `llmRawChatCompletion` | `outer-conversation-loop` / `outer-heartbeat` | C 阶段已暴露 `LlmToolCallFn` 注入点（保留 raw 模式默认） |
| `llmChatCompletion` | `inbound-policy.participationSpeakLlm` | C 阶段已暴露 `LlmChatFn` 注入点 |

### S4. 文件系统通过 rootDir 收口

**红线**：任何写文件函数必须接 `rootDir` / `workDir` / `dataRoot` 参数；
禁止从 `import.meta.url` 或 `process.cwd()` 算路径。

现状：内脑 `BrainFS(workDir)` 已经做得很好；外脑 `dataRoot` 大部分已收口，但仍有少量散落（重构期间一并清理）。

### S5. 时间可注入

**红线（新代码）**：模块工厂接受可选 `clock: () => number`，默认 `() => Date.now()`。

老代码不强求改；新加的频控、超时、deadline 必须支持注入时钟。

### S6. 跨模块协议用命名 type

**红线**：跨进程、跨模块的输入输出**必须**有命名 type（已在用 Zod / TS interface）。
禁止 `Record<string, unknown>` 透传。

现状：`PendingItem` / `ControllerState` / `OuterInboundMeta` / `StructuredReply` / `MessageRecord` 都已是命名类型 ✓。

### S7. 测试边界 = import 边界

**红线**：

- 内脑测试**不允许** `import` 任何 `outer/*` 或 `index.ts`。
- 外脑测试**不允许** `import` `openkuroneko/controller/*` 的内部（只能读它对外协议：output 文件、`pendings.json`、`InnerBrainRegistry`）。
- Chat IR 测试**不允许** `import` `server/*`。

**当前不加 ESLint 强制**（个人项目，按需补）；通过 code review 守。

---

## 4. 模块测试矩阵

> 表中"单元"="纯函数 `.test.ts`"；"模块"="临时 workDir + `.integration.test.ts`"。
> **状态**：✅ 已有 / 🟡 部分 / ❌ 待补。
>
> **与 Structurizr ADL 对齐（2026-05-21 起）**：每个 L3 component 按 [`doc/structurizr/COMPONENT-TESTING.md`](structurizr/COMPONENT-TESTING.md) 设计用例；清单见 [`COMPONENT-TEST-MAP.md`](structurizr/COMPONENT-TEST-MAP.md)。文件命名：`<moduleId>.component.integration.test.ts`，`describe('component: <moduleId>')`。本 §4 矩阵仍作按域汇总。

### 4.1 Chat 协议层

| 模块 | 单元 | 模块 | 关键缺口 |
|------|------|------|----------|
| `@utlra/chat-ir` mention | ✅ | — | — |
| `@utlra/chat-ir` seen-tracker | ✅ | — | — |
| `@utlra/chat-ir` reply-utils | ✅ | — | — |
| `@utlra/chat-ir` identity-registry | ✅ | ❌ | 多进程并发 upsert |
| `@utlra/webchat-protocol` ids | ✅ | — | — |
| `@utlra/webchat-bridge` reply-render | ✅ | — | — |
| `@utlra/webchat-bridge` thread-mapper | ✅ | ❌ | 入站 webchat → MessageRecord 全链路 |
| `@utlra/core` workspace / repository | ✅ | — | — |

### 4.2 外脑

| 单元（纯函数 + 错误兜底） | 文件 | 状态 |
|----------------|------|------|
| `shouldReplySyncRules` / `decideOuterShouldReply` / `loadInboundConfigFromEnv` | `outer/inbound-policy.ts` | ✅（D 阶段 22 用例 → 翻转后 20 用例：删 2 条 fake SPEAK/SILENT，迁至 prompt 套件） |
| `resolveThreadMeta` | `outer/outer-brain.ts` | ❌ 待抽出 → 单文件 |
| `shouldRecordKpiIdle` | `outer/kpi-burst-hooks.ts` | ✅ |
| `shouldAutoAchieveKpi` | `outer/kpi-progress.ts` | ✅（D 阶段扩到 8 个边界，含 failed / partial / 无 reflexion / 无 deliverable） |
| `suggestKpiAction` / `formatKpiDigest` | `outer/kpi-progress.ts` | ✅（D 阶段补 12 用例覆盖终态 / DONE / async / BLOCKED / streak / RUNNING / 优先级） |
| `buildCompletionReport` | `openkuroneko/controller/completion-report.ts` | ✅ |
| `shortenMilestonesForReport` / `pickDeliverableExcerpt` | 同上 | ✅ |
| `buildBrainAsyncSnapshot` | `outer/brain-async-snapshot.ts` | ✅ |
| `attach-expand` | `outer/attach-expand.ts` | ✅ |
| `agent-reply-mention-normalize` | `outer/agent-reply-mention-normalize.ts` | ✅ |
| `parseControlFlag` 等解析 | `outer/orchestrator.ts` | 🟡 |

| 模块（黑盒契约） | 入口 | 状态 |
|-------------------|------|------|
| 外脑入站决策 | `decideOuterShouldReply(input, mockLLM)` | ❌ |
| KPI lifecycle | `processBurstExitForKpi` + 临时 dataRoot | ✅（已写） |
| 完成通知 | `notifyInnerBrainTaskComplete` + FakeIm | ✅（已写） |
| 外脑一次 roundtrip | `runOuterRoundtrip(input, mockLLM)` | ❌ |
| 心跳一次 tick | `OuterHeartbeat.tick(mockLLM)` | ❌ |

| Prompt 效果（真实 LLM） | 入口 | 状态 |
|---------------------------|------|------|
| `participationSpeakLlm` 格式遵守（产出可被解析为 SPEAK/SILENT） | `outer/inbound-policy.prompt.test.ts` | ✅（D' 阶段 2 用例） |
| `decideOuterShouldReply` 群聊 needs_llm 全链路（真实 LLM 决策） | 同上 | ✅（2 用例：私事→SILENT 软期望，技术求助→SPEAK 软期望） |
| Attributor prompt 产 CONTROL flag 准确性 | `controller/attributor.prompt.test.ts` | ✅（4 场景，格式硬断言） |
| Decomposer prompt 产合格 milestones | `controller/decomposer.prompt.test.ts` | ✅ |
| Reflexion prompt 产可解析的 reasoning_json | `controller/reflexion.prompt.test.ts` | ✅（BLOCK + COMPLETE） |

### 4.3 内脑

| 单元（纯函数 / 解析层） | 文件 | 状态 |
|---------------------------|------|------|
| Pendings 读写 | `openkuroneko/pendings/pendings-fs.ts` | ✅（基础 + D 阶段补 timer / expire 边界，共 24 用例） |
| `parseIntent` | `tools/definitions/async-wait.ts` | ✅ |
| `parseReflexionJson` / `writeReflexionJson` | `controller/reflexion.ts` | ✅ |
| `parseControlFlag` | `controller/attributor.ts` | ✅（D 阶段补完，12 用例覆盖中英冒号 / markdown 加粗 / 大小写 / 末尾兜底） |
| `parseMilestonesFromContent` / `parseMilestoneLine` / `applyMilestoneContractLine` | `brain/brain-fs.ts` | ✅（D 阶段补，22 用例覆盖普通 / cyclic / 契约行 4 标签同义词 / 非法格式） |
| Executor 响应解析 | `controller/executor.ts` | 🟡 |
| BrainFS 状态字段 | `brain/brain-fs.ts` | 🟡 |
| Capability gap | `tools/definitions/capability-gap.ts` | ✅ |
| ChangeWatcher tick 判定 | `pi-mono/change-watcher.ts` | ✅ |

| 模块（黑盒契约） | 入口 | 状态 |
|-------------------|------|------|
| 一次 tick：DECOMPOSE → EXECUTE → ATTRIBUTE | `runOpenKuronekoPiMonoAuto({ workDir, mockLLM })` | ❌ |
| 一次 burst：goal → COMPLETE 事件 | 同上 + 断言 `.run/pi-mono/output` | ❌ |
| 等待 timer：`wait_timer` → AWAITING → ChangeWatcher 翻牌 | `runTick + change-watcher` 临时 dir | ❌ |
| 完成报告写盘 | controller.handleAllCompleted | 🟡 |

### 4.4 装配

| 入口 | 测什么 | 状态 |
|------|--------|------|
| `index.ts` startup | 起得来、端口可监听、能 graceful shutdown | ❌ |
| `index.ts` 假入站 → 假出站 | 端到端 smoke | ❌ |

装配测试**最后做**，等内脑、外脑模块测试稳定。

---

## 5. 目录与文件约定

```
doc/
  testing-strategy.md          ← 本文
  protocols/
    *.md
packages/<pkg>/
  src/
    foo.ts
    foo.test.ts                ← 单元，与源文件 colocated
    bar.ts
    bar.integration.test.ts    ← 模块，可单独配置 timeout
    baz.live.test.ts           ← 默认 skip（连真 API）
  fixtures/
    llm-replies/
      decomposer-2-milestones.json
      attributor-cap-gap.json
    workspaces/
      completed-with-deliverable/   # 全套 .brain/ + .run/
      awaiting-timer/
  vitest.config.ts
  vitest.integration.config.ts   # 仅 server 当前必需
  package.json                   # 三个脚本：test / test:unit / test:integration
```

**测试代码禁忌**：

- 单测里 `JSON.parse(fs.readFileSync(...))` 引入大块 mock 数据 → 改用 `loadFixture('name')` 工具函数。
- 测试间共享可变状态 → 每个 `it()` 自己 `mkdtemp`。
- `beforeAll` 启动真服务 → 改写成 fixture 或 `live.test.ts`。

---

## 6. 命令面

### 6.1 包级

```bash
cd packages/server
npm run test              # 单元 + 集成 + Prompt 效果（三联）
npm run test:unit         # 仅单元（无网络，默认 < 30s）
npm run test:integration  # 仅集成（临时 workDir）
npm run test:prompt       # 仅 Prompt 效果（真实 LLM；缺 key 直接 fail）
npm run test:watch        # 开发
VITEST_LIVE=1 npm run test:live   # 真服务（可选；目前未配 live 套件）
```

**首次跑 `test:prompt` 前**：

1. 仓库根 `.env` 配置任一 provider key（`ZHIPU_API_KEY` / `KIMI_API_KEY` / `LOCALMODULE_API_KEY`）。
2. `vitest.prompt.config.ts` 会自动 dotenv 加载根 `.env` / `.env.local`，无需手工 `--env-file`。
3. 真实 LLM 调用慢（单测 2-10s/case），耗 token，**只跑 prompt 套件可控**——`test` 主链跑全套是工作流签收时再走。

### 6.2 Monorepo

```bash
npm test                          # 所有 workspace 的 test:unit 串联
npm run test:integration:all      # 各包 test:integration
```

---

## 7. 实施路线

### A. 设计落地（本阶段 · 完成）

- 产出本文档。
- 表格化模块测试矩阵。

**Exit criteria**：本文档 review 通过。

### B. 立标准（下一步）

**只新增工具与模板，不改业务代码**：

1. 新建 `packages/<pkg>/src/config/*` 模板：`loadInboundConfigFromEnv` / `loadControllerConfigFromEnv` 等。
2. 把 `LLMAdapter` 接口规范化（已存在；补 doc 与 `createMockLLM` helper）。
3. 新建 `packages/server/src/testing/`（已存在 KPI harness，扩成统一 testing kit）：
   - `temp-data-root.ts`
   - `fake-im-channel.ts`
   - `fake-llm.ts`
   - `workspace-factory.ts`
   - `load-fixture.ts`
4. 写 `vitest.integration.config.ts` 模板（server 已有，复用）。
5. 写 1 篇 `docs/how-to-write-tests.md`（短）。

**Exit criteria**：testing kit 自检通过；不影响线上行为。

### C. 重构（行为不变）✅ 已完成

| 文件 | 抽什么 | 实际落地 |
|------|--------|----------|
| `outer/inbound-policy.ts` | 4 处 env → `InboundConfig`；`llmChatCompletion` → 注入的回调 | `loadInboundConfigFromEnv()` / `LlmChatFn`；`shouldReplySyncRules` + `decideOuterShouldReply` + `participationSpeakLlm` 全部支持可选注入；老 `resolveProactiveLevel` / `resolveParticipationUseLlm` 保留 wrapper |
| `openkuroneko/controller/controller.ts` | `INNER_KPI_ID` → `ControllerContext.kpiId` | `ControllerContext.kpiId?` 优先；env 兜底兼容 inner-brain-spawner 的子进程注入路径 |
| `outer/outer-heartbeat.ts` | 5 处 env → `HeartbeatConfig` | `loadHeartbeatConfigFromEnv()`；`HeartbeatDeps.config?` 注入入口；启动 / `runHeartbeat` 都走 config 不再读 env |
| `outer/outer-conversation-loop.ts` | `llmRawChatCompletion` → 注入回调 | `LlmToolCallFn` + `defaultOuterLlmToolCall`（保留 raw 模式）；`ConversationLoopOptions.callLlm?` / `.config?`；agentName / maxTokens 走 `loadConversationLoopConfigFromEnv()` |

> **关于 §7 C 原文 "→ `LLMAdapter` 参数"**：实测发现强行换 `LLMAdapter` 会牵涉 max_tokens / temperature / thinking / tool_choice 参数行为对齐，破坏"行为不变"承诺。改为暴露可注入函数类型 `LlmToolCallFn`，缺省仍走 raw 模式；单测注入即可绕开 HTTP，对线上行为零影响。

**Exit criteria 验证**：

- `tsc --noEmit`：0 error
- `npm run test:unit`：29 文件 / 176 用例全过（基线一致）
- `npm run test:integration`：2 文件 / 4 用例全过
- `git diff` 内仅 refactor + 注释，无控制流变更

### D. 第一批单元测试 ✅ 已完成（含 D' Prompt 套件方向翻转）

按矩阵 §4 补，实际落地：

| 文件 | 用例数 | 关键覆盖 |
|------|--------|----------|
| `outer/inbound-policy.test.ts`（新增） | 22 | DM / 群 @ / level 0/1/2/3 / cooldown 配置 / group invite / `needs_llm` + FakeLLM 注入 SPEAK / SILENT / 抛错兜底 / `useLlmForParticipation=false` / `loadInboundConfigFromEnv` env 解析鲁棒性 |
| `openkuroneko/controller/attributor-parse.test.ts`（新增） | 12 | 5 个 ControlFlag 直接命中 + 中文/全角冒号 / markdown 加粗 / 反引号 / 大小写鲁棒 / 末尾关键词兜底 / 完全无关 → 保守 REPLAN / 多行 REASON 截断 |
| `openkuroneko/brain/parse-milestones.test.ts`（新增；替代原计划的 `decomposer-parser.test.ts`，更贴近代码归属） | 22 | 普通 / cyclic 里程碑解析、契约行四标签同义词 / 多行合并 / 全角冒号 / 注释行忽略 / 孤儿契约行丢弃 / warnOnFail 触发 / 非法 cyclic 兼容 |
| `openkuroneko/pendings/pendings-fs.test.ts`（扩） | 14 → **24** | 新增：`resolveDueTimers` 多 timer 一次性翻牌 / now 注入 / fired_at + planned_at 形态 / `nextDeadlineMs` 空集合 / resolved 不计入 / `expireOverduePendings` 默认 block / 已 resolved 不再过期 / 非法 ISO 不抛错 |
| `outer/kpi-progress.test.ts`（扩） | 3 → **23** | 新增：`shouldAutoAchieveKpi` 4 个反例（failed verdict / 无 deliverable / partial / 无 reflexion） + `suggestKpiAction` 全分支（终态 / DONE+post-complete+success / async waiting / BLOCKED / streak ≥ 阈值 / RUNNING / streak > 0 / 完全活跃）+ 3 个优先级用例 |

**Exit criteria 验证**：

- 总用例：176 → **262**（+86 ≫ Exit 要求的 +30）
- 单元测全套 1.63s，每个用例平均 < 7ms，远低于 50ms 上限
- `tsc --noEmit`：0 error
- `test:integration`：4/4 全过，无退步

> 命名调整：原计划的 `decomposer-parser.test.ts` 改为 `parse-milestones.test.ts` 放在 `brain/` 目录，与导出位置一致。`runDecomposer` 是 LLM 调用包装，没有独立 parser；真正的解析逻辑在 `parseMilestonesFromContent` / `parseMilestoneLine` / `applyMilestoneContractLine`，归属 brain-fs 更合理。已在矩阵 §4.3 同步。

### D'. Prompt 套件方向翻转 ✅ 已完成（2026-05-17 拍板）

D 阶段结束后，用户明确「**原则上优先真实 LLM**——测 prompt 效果必须真实，否则才用 FakeLLM」。
原 §S3 「单测里替换为 mock LLM」被翻转为「单测**禁止**真实 LLM，prompt 效果**必须**真实 LLM」。

落地（不动业务编排，仅调整测试体系）：

| 改动 | 内容 |
|------|------|
| 新增后缀层 | `*.prompt.test.ts`（独立 `vitest.prompt.config.ts`；自动 dotenv 加载根 `.env`；timeout 120s） |
| 新增 helper | `src/testing/require-llm.ts::requireLlmEnvForPrompt()` —— 缺 key 直接抛错（用户拍板 Q2=B） |
| 主链脚本 | `npm test` 改三联：unit → integration → prompt；`test:prompt` 独立可单跑 |
| Unit / Integration 配置 | exclude `*.prompt.test.ts`，避免误跑 |
| 旧 fake 用例处理 | `inbound-policy.test.ts` 删除 2 条 fake SPEAK/SILENT（22 → 20），迁至 prompt 套件（用户拍板 Q3=B） |
| 新增 prompt 套件 | `inbound-policy.prompt.test.ts`：4 用例（participationSpeakLlm 格式遵守 ×2、decideOuterShouldReply 群聊 needs_llm 真实 LLM 全链路 ×2） |

**Prompt 体系上线即捕获生产 bug**（这是真实 LLM 测试的核心价值）：

1. **bug A · LocalModule provider 强制忽略 thinking 字段** ——
   `raw.ts::normalizeProviderRequestBody` 对 `provider=localmodule` 显式剥离 thinking。
   修复：取消剥离，把字符串 `'enabled' | 'disabled'` 规整成 GLM 网关接受的 `{ type }` 形态透传；
   新增 3 个 raw.ts 单测护栏（规整 / 已是对象保持原样 / 缺省不引入新字段）。
2. **bug B · GLM-5.1-FP8 实测无视 `thinking: { type: 'disabled' }`** ——
   curl 探针证实 A/B 两种调用响应完全一致，GLM fp8 量化版**强制 thinking**。
3. **bug C · participationSpeakLlm 用 maxTokens=32 在强制 thinking 模型下 100% empty content** ——
   thinking 至少吃 35+ tokens，content 留空。
   修复：业务侧把 `maxTokens: 32 → 1024`（finish_reason 是 stop，多余 budget 不真扣）。
4. **观察 · 技术求助场景 prompt 偏保守**（软警告）——
   prompt test 跑出"我刚部署完，谁帮我跑一下 health 端点" → SILENT，
   说明 system prompt 的"参与策略：积极"在 level=3 下仍不够明确。**记录但不 fail**，留作未来 prompt 迭代输入。

**Exit criteria 验证**：

- `npm run test:unit`：32 文件 / **263** 用例全过（D 阶段 262 - 2 删 + 3 raw.ts 护栏）
- `npm run test:integration`：4/4 全过
- `npm run test:prompt`：1 文件 / **4** 用例全过（真实 LLM，~16s）
- `npm test` 三联合计：35 文件 / **271** 用例全过
- 行为变化：仅 `participationSpeakLlm` 的 maxTokens 32 → 1024（修 bug，不是 refactor）+ LocalModule provider 透传 thinking（修 bug）

### E. 模块测试（按 §S3 翻转后原则切分两轨）

按矩阵 §4 补，**E 阶段拆分两条轨道**：

**E.1 模块编排（不涉及 prompt 效果，可用 FakeLLM）**

1. `outer/inbound.integration.test.ts`：表驱动 + FakeLLM，覆盖 DM / 群 @ / proactive 等级 / 节流频控
2. `openkuroneko/controller/run-burst.integration.test.ts`：固定 fixture goal + FakeLLM 脚本 → 断言 `.brain/` / `.run/pi-mono/output`
3. `pi-mono/await-and-wake.integration.test.ts`：内脑 `wait_timer` → ChangeWatcher 1s 翻牌 → 二次 tick（不调 LLM）
4. `outer/heartbeat.integration.test.ts`：心跳读 inner-status → FakeLLM 模拟"决策不 set_goal"

**E.2 Prompt 效果（真实 LLM，按 D' 体系延展）**

1. `openkuroneko/controller/attributor.prompt.test.ts`：Attributor prompt 能产可被 `parseControlFlag` 识别的 CONTROL flag（≥4 场景：成功 / 失败 / 容量不足 / 需重规划）
2. `openkuroneko/controller/decomposer.prompt.test.ts`：Decomposer prompt 能产合格 milestones（满足 `parseMilestonesFromContent` 契约，关键标签同义词覆盖）
3. `openkuroneko/controller/reflexion.prompt.test.ts`：Reflexion prompt 能产可解析的 reasoning_json（schema 字段齐全）

**Exit criteria**：
- E.1：每个文件 < 30s；可单独跑通；CI 跑 < 3min。
- E.2：每个文件 < 60s（含真实 LLM 等待）；缺 key 直接 fail；用语义匹配断言（不强求字符串精确）。

### F. 装配 smoke

最后再做。两个 case：

- `index.ts` 起停（监听端口、graceful shutdown）。
- 假入站 → 假 LLM → 假 IM 出站。

---

## 8. 反例（禁忌清单）

- ❌ 测试里写 `process.env.X = '0'`（应注入 config）。
- ❌ 测试调用真 `fetch()`（除非 `.live.test.ts` 或 `.prompt.test.ts`）。
- ❌ `beforeAll` 起 server / DB 连接（除非 `.integration.test.ts` 且单文件隔离）。
- ❌ 单测 import 跨模块（外脑测试 import 内脑实现）。
- ❌ 用 `vi.useFakeTimers()` 同时改全局 `Date` —— 改用注入的 `clock`。
- ❌ 大段 inline JSON mock —— 改成 `loadFixture(name)`。
- ❌ "顺便测一下集成"（在单测里跑半个 controller）—— 拆到 `.integration.test.ts`。
- ❌ **`*.test.ts` 里调真实 LLM**（哪怕只想"看看效果"）—— 一律搬到 `*.prompt.test.ts`。
- ❌ **`*.prompt.test.ts` 用 `expect(text).toBe('SPEAK')`** —— LLM 输出有抖动，必须语义匹配 `/SPEAK|SILENT/i`。
- ❌ **`*.prompt.test.ts` 硬断「类别正确」**（如「必须返回 SILENT」）—— 类别正确性是 LLM 能力问题，
  prompt test 只硬断「格式遵守」，类别正确性用软警告（`console.warn`）记录。

---

## 9. FAQ

**Q1：现有 `mem9-client.test.ts` 连真服务怎么办？**
A：B 阶段重命名为 `mem9-client.live.test.ts`，默认 skip；同时新增 `mem9-client.test.ts` 用 mocked fetch。

**Q2：内脑要不要拆成独立 npm 包？**
A：**暂不**。当前 `openkuroneko/` + `pi-mono/` 在 `@utlra/server` 内部即可，靠 §S7 import 边界守。
将来若多个 server 复用，再升级为 `@utlra/inner-runtime`。

**Q3：fixture 怎么生成？是否要录真 LLM 响应？**
A：B 阶段提供 `tools/record-llm-fixture.ts`，可选录一次。日常手写 fixture 即可（控制器对 LLM 响应只关心结构）。

**Q4：如果测试覆盖率指标重要吗？**
A：**不强求百分比**。指标是"每个模块都有契约入口的模块测试 + 关键纯函数有单测"。

**Q5：本文档什么时候更新？**
A：每完成一个实施阶段（B–F）打勾；新增模块时在 §4 矩阵登记自己的测试入口。

---

## 10. Changelog

| 日期 | 内容 |
|------|------|
| 2026-05-16 | 初版：测试框架锁定 Vitest，定义 7 条标准，给出模块矩阵与 A–F 实施路线 |
| 2026-05-16 | B 阶段完成：新增 `fake-llm.ts` / `clock.ts` / `load-fixture.ts` + testing kit 自检 11 用例；fixtures 目录约定；`doc/how-to-write-tests.md` 速查表 |
| 2026-05-17 | C 阶段完成：4 个文件零行为变更重构；env 经 `loadXxxConfigFromEnv()` 收口，LLM 调用经函数注入点替换；176 单元 + 4 集成用例全过；§7 C 表格更新原 "LLMAdapter 参数" 妥协为 `LlmToolCallFn` 注入点（保留 raw 模式默认） |
| 2026-05-17 | D 阶段完成：新增 / 扩 5 个单元测试文件，单元用例 176 → **262**（+86）；覆盖入站策略全分支 / ControlFlag 兼容解析 / 里程碑契约解析 / pendings timer 边界 / KPI 进展决策全路径；§4 矩阵同步打勾；命名微调（`decomposer-parser.test.ts` → `parse-milestones.test.ts`） |
| 2026-05-19 | F index listen：`spawn-index-process` + `index-listen-smoke`；`index.ts` SIGTERM/SIGINT 优雅关停 pushLoop / changeWatcher / heartbeat / channel |
| 2026-05-19 | F 可选 live：`spawn-inner-worker-live` + `require-spawn-inner` 门控；`vitest.integration` 加载根 `.env`；`how-to-write-tests` §7.1 / §11 |
| 2026-05-19 | F 装配加深：`runOuterRoundtrip` 支持 `spawnInnerBurst` 注入；`outer-roundtrip-inner` / `outer-brain-channel-wire`；`FakeImChannel.wireInbound` / `emitInbound`；`index` 导出 `app` + `UTLRA_SKIP_AGENT_BOOTSTRAP` |
| 2026-05-17 | D' Prompt 套件方向翻转：§S3 由「单测里 mock LLM」翻为「**原则上优先真实 LLM**，prompt 效果必走真实，否则才用 FakeLLM」；新增 `*.prompt.test.ts` 后缀层 + `vitest.prompt.config.ts` + `requireLlmEnvForPrompt()` helper（缺 key 直接 fail）；`inbound-policy.test.ts` 删 2 条 fake SPEAK/SILENT（22→20），新增 `inbound-policy.prompt.test.ts`（4 用例 真实 LLM）；上线即捕获并修复 LocalModule provider thinking 字段被剥离的真 bug 与 `participationSpeakLlm` maxTokens=32 在强制 thinking 模型下 empty content 的 bug；`npm test` 三联合计 35 文件 / **271** 用例全过 |
