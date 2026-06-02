# 内脑 Designer–Runner（DyFlow-style）—— 替换三件套

> **English:** Replace the legacy `decomposer / executor / attributor` FSM with a **Designer + Runner** loop inspired by [DyFlow (arXiv 2509.26062)](https://arxiv.org/html/2509.26062v1). Designer plans a **local DAG** of `NodeInst`; Runner executes; baseNode 「猛猛干」 with full ReAct, surfacing only **terminal high-confidence failures** back to Designer. No stages, no milestones, no Attributor.

> **配套**：[`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md)（LocalNode/NodeDef/Abstractor/Assembler/auto-export/eviction）。

> **状态**：设计定稿（2026-06-02）· **实现**：分 P0→P2 落地；旧三件套与其 `.brain/*` 写入路径在 P0 起逐步退役。

---

## 1. 动机：旧三件套为什么要换

| 现象（bot2 / data-yuanbao 实际 burn） | 根因（旧 FSM 设计层） |
|---------------------------------------|----------------------|
| 单 burst >20M token；EXECUTE 35 轮 ×22 工具 ×21 LLM | EXECUTE 内 ReAct 无明显边界，Attributor 每轮重灌全文 |
| 同一战术（登录 → search → preview）反复现场写脚本 | 没有「可固化战术 = 节点」的一等公民；skill 只是 prose |
| Attributor 强写 `.brain/*`，跨 burst 知识形态僵硬 | 「写 markdown」≠「可机械引用」；Designer 拿不到结构化资产 |
| Milestone checklist 化 → Executor「先步骤 1 再步骤 2」 | DECOMPOSE 一次拍板 + Attributor 单 CONTROL 字符 → 早凝固 |

DyFlow 论文的核心在 **每步 replan + flat operator + global memory**；本设计把它落到 Kuroneko 的真工具世界，并补上 **节点固化 / 共享 / 修复** 三个论文未覆盖能力。

> **2026-06-02 起 DyFlow 为唯一内脑引擎**：旧三件套（decomposer/executor/attributor/blockResolver）及 reflexion、`INNER_BRAIN_ENGINE` flag、`INNER-EXECUTE-INCREMENTAL.md` 均已删除。

---

## 2. 三大不变量

| ID | 不变量 | 说明 |
|----|--------|------|
| **D1** | **词表只有两形态**：`baseNode` + `newNodeCreator` | RUN 图同质；`preset/*` 与 Creator 产出都是 LocalNode |
| **D2** | **baseNode = 原 Executor（猛猛干）** | LLM + 工具 + ReAct；失败不在内回 Designer，**自修到底** |
| **D3** | **Designer 只接 terminal 高置信失败** | Runner 写 `memory.last_failure`；Designer 改图，不微操步骤 |

D1 保证元编程一层（Creator 提升仍是同一种 ref）；D2 不浪费 ReAct 已有的现场感；D3 保证外循环只承担战略决策。

---

## 3. 状态机（替换旧 FSM）

```text
controller-state.json mode:
  DESIGN → RUN → AWAITING → DONE
```

| mode | 动作 | 谁主导 |
|------|------|-------|
| **DESIGN** | 读 goal + memory + last_failure + LocalNode index → 调 Designer Tools → 写 `local_dag.json` 或宣告 DONE | Designer LLM |
| **RUN** | 顺序/依边走 `local_dag`；按 NodeInst 派发 baseNode / newNodeCreator | Runner（无 LLM 决策）|
| **AWAITING** | `pendings.json` 等 timer / human；与 [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md) §4–§6 一致 | 外脑 changeWatcher / awaitingInboundResolver |
| **DONE** | 子进程退出；registry **DONE**；同 KPI canonical instance 可由外脑再 spawn | controller 自报 + 外脑 KPI 判定 |

转移规则（与 `registryLifecycleReconcile` 对齐）：

```text
DESIGN  → RUN          : Designer 输出 local_dag 非空
DESIGN  → DONE         : Designer 自报「目标已完成」 / `memory.kpi_progress` 已满
DESIGN  → AWAITING     : local_dag 含 wait_timer / ask_user
RUN     → DESIGN       : 图跑完 / terminal failure
RUN     → AWAITING     : node 内触发 async pending
AWAITING → DESIGN      : pendings 全部 resolved/timed_out
DONE    → DESIGN       : 同 instance 再 spawn（外脑 KPI 未完成）
任意   → ERROR/STOPPED : 同旧 FSM
```

旧 mode 映射（删除时清单）：

| 旧 mode | 处理 |
|--------|------|
| `DECOMPOSE` | **删** — 不再有 milestones |
| `EXECUTE` | → `RUN`（内核语义不同：猛猛干，无早停） |
| `ATTRIBUTE` | **删** — Designer 替代决策；`memory.last_failure` 替代 `execution-context` |
| `BLOCKED` | 并入 `DESIGN`（high-confidence failure → Designer 决策 abort/换 ref） |

---

## 4. NodeInst schema（图里的一格）

```text
NodeInst {
  id:           string             # local_dag 内唯一
  ref:          string             # LocalNode id（如 "preset/base" / "local/ps_open_battle"）
  instruction?: string             # φ：Designer 本轮细指令；可选
  params?:      Record<string, unknown>  # 覆盖 LocalNode 默认（路径/账号 binding）
  memoryIn?:    string[]           # 额外读哪些 memory key（默认 last_failure + node_results.<id>）
  memoryOut?:   string[]           # 写回 memory 的 key 名（默认 node_results.<id>）
}
```

**约束**：

- `instruction` 非必填；缺省时 baseNode 仅按 LocalNode 模板 + memory 跑（DyFlow 默认）
- 失败重排同 `ref`：Designer **必须**或写 `instruction`，或在 prompt 里说明 `transient` —— 防傻重试（详见 §6.3）
- `params` 不渗入 prompt 模板；Resolver 在 LocalNode body 替换占位符（与 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §3 对齐）

---

## 5. local_dag.json schema

```text
local_dag {
  burstId:    string                # 当前 burst（registry id）
  designedAt: ISO8601
  nodes:      NodeInst[]            # P0 顺序图；P1 起加 edges
  edges:      { from: id, to: id }[] # P0 默认按 nodes[] 顺序；可省略
  entry?:     id                    # 默认 nodes[0]
  notes?:     string                # Designer 自留
}
```

**P0 简化**：`edges/entry` 可不填，按数组顺序串行；`memoryIn/memoryOut` 用默认。  
**P1**：加并行/失败边（仍只表达 DAG，控制流走 Designer replan，不在边上做 if/else，**与 DyFlow 一致**）。

---

## 6. baseNode：猛猛干 + 高置信失败

### 6.1 执行约定

```text
baseNode（preset/base 或 Creator 派生）
  Runner 入口:
    prompt = systemSlice(LocalNode.body.executor.promptTemplate)
           + userSlice(memory + goal + NodeInst.instruction?)
    tools  = LocalNode.body.executor.tools  (allowlist)
    LLM ReAct loop（**无早停**；有兜底防烧）
      工具失败 → 自行重试 / 换路径 / 改参数
      **连续无进展**（默认 5 轮内无任何 `ok:true` 工具结果，`INNER_BASE_NODE_FAIL_FAST_STREAK`）→ transient `last_failure`，上交 Designer（可由 Designer 安排重试）
      **绝对轮次上限**（默认 10，`INNER_BASE_NODE_MAX_ROUNDS`）→ 同上 transient
      达到「不可继续」判定 → 写 failure_summary，退出
      达到目标 / interface.outputs 全部满足 → ok 退出
```

**禁止**：

- baseNode 内部生成新 LocalNode（那是 newNodeCreator 职责）
- baseNode 改 `local_dag`（那是 Designer 职责）
- baseNode 跨 NodeInst 读写 memory **未声明** key（除 last_failure）

### 6.2 failure_summary（terminal failure 时）

```text
memory.last_failure = {
  nodeInstId:  string
  localRef:    string
  summary:     string                # 一段话：原因 + 影响
  attempted:   string[]              # 关键尝试列表（不堆原始 stderr）
  confidence:  "high" | "low"        # 默认 high；唯有 transient 信号才 low
  transient?:  boolean               # true → Designer 可考虑同 ref 重排
  rawTail?:    string                # 截断的 ≤ 1KB 原始 tail（debug 用）
  at:          ISO8601
}
```

判定 terminal 的硬条件（满足任一即可写 last_failure）：

| 条件 | 例子 |
|------|------|
| **不可恢复工具错** | 路径不存在、登录永久失败、契约违反 |
| **资源耗尽** | 同 node 内多轮仍同错（baseNode 自己已重试到无新信息）；或 **fail-fast streak**（连续 N 轮工具全无 `ok:true`）|
| **输出契约缺失** | LocalNode `interface.outputs` 强制字段未产出 |
| **显式放弃** | LLM 输出 `CANNOT_CONTINUE: <reason>`（prompt 约定） |

**非 terminal**（已自修）：不写 `last_failure`，写 `memory.node_results[id] = ok`。

### 6.3 Designer 失败决策表（写进 Designer prompt）

读到 `memory.last_failure (high)` 时，Designer 优先级：

```text
1. abort + 换 ref / search_and_instance（找别的 LocalNode）
2. 同 ref + 新 instruction（换战术，不是裸重试）
3. 排 newNodeCreator(repair) → 改 LocalNode 定义
4. DONE / AWAITING（等人或外脑）
5. 同 ref 裸重排 — 仅 transient=true 才允许
```

「**裸重试同 ref** 在 last_failure.confidence=high 下默认拒收」是 Designer 输出契约的硬约束。

---

## 7. newNodeCreator（图里的一格）

| 维度 | 取值 |
|------|------|
| **本质** | baseNode 的特化：tools 仅 `commit_local_node`；LLM 推断打包边界 |
| **mode** | `pack`（成功路径打包成 compound）／`specialize`（特化某 base 模板） |
| **输入** | NodeInst.params: `{ mode, target?, hint?, source_node_ids? }` |
| **输出** | `.brain/local_nodes/<id>.json` + 更新 `local_nodes/index.json`；触发 Abstractor（auto-export，见 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §5） |
| **失败** | 写 `memory.last_pack_error` → DESIGN |

**修复**：本设计**不**给 Creator 加 `repair` mode；修复走 NodeInst.instruction（Designer 写战术）+ 必要时 Creator `pack` 把成功修复路径再打成新版本（dedupe + version bump，见 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §6）。

---

## 7b. 固化的三层：facts / LocalNode / **Tool**（晋升准则）

> bot2 首跑（`ib-mpwfiv02-2887`）暴露：9 个成功节点全是 `preset/base`，**0 提升**。复盘发现「应提升」项里**多数其实更适合做成 Tool（一次 function call），而非再 pack 成会 ReAct 的 LocalNode**。

「成功经验」有三种固化形态，**成本递减、确定性递增**：

| 层 | 载体 | 谁调用 | 成本 | 适用 |
|----|------|--------|------|------|
| **A 事实** | `memory.facts`（`record_fact` / `preset/extract_facts`） | Designer / baseNode 读上下文 | 读 | 知识、选择器、API 形状、账号归属 |
| **B 节点** | LocalNode（`preset/node_creator` pack） | Designer 排 `ref: local/…`，**仍 LLM ReAct** | 中（prompt 更短，仍多轮） | **仍需临场判断分支 / 改参 / 组合多工具 / 解释失败** 的战术 |
| **C 工具** | Tool（`ws_*` 脚本工具 / preset TS 工具） | baseNode **一次 tool_call** | 低（无探索轮次） | **步骤已固定、可 (inputs)->(outputs) 说清、无 LLM 分支** 的原子动作 |

**晋升判定（RUN 结束复盘按序问）：**

```text
1. 步骤可写成 (inputs) -> (outputs) 且无需 LLM 分支？
     → C：register_workspace_script_tool（T0）或提 PR 加 preset 工具（T1）
2. 只是知识 / 选择器 / API 形状？
     → A：extract_facts
3. 战术仍要临场改参、组合多工具、解释失败？
     → B：node_creator pack
```

**反例（bot2 教训）**：登录 PS、查 ELO、跑 `ps_playwright_v6.py` 都是 **C**，pack 成 LocalNode 会让 LLM 在「登录」上再烧 12+ 轮；而「据 last_failure 换对战格式」才是 **B**。

### 7b.1 工具晋升的三档

| 档 | 机制 | 安全边界 | 落地阶段 |
|----|------|----------|---------|
| **T0** | **workspace 脚本工具**：`register_workspace_script_tool` 把 workDir 内脚本声明为可调用 Tool（运行时 materialize 成 `ws_<name>`，一层 `runCommand` 包装） | 脚本路径必须在 workDir 内；名字强制 `ws_` 前缀，不覆盖核心工具 | **P0b（本次）** |
| **T1** | Designer / 运维审核后，把稳定能力提 PR 进 `tools/definitions/*.ts` 成 preset 工具 | 代码 review | 人工 |
| **T2** | LLM 生成 TS + 测试 + 合并（真·createTool） | 沙箱 + 测试门 | 远期 |

### 7b.2 T0：`register_workspace_script_tool`

| 维度 | 取值 |
|------|------|
| **注册者** | baseNode（与 memory 工具同注入；preset/base prompt 提示） |
| **入参** | `{ name, description, interpreter(python\|node\|pwsh\|bash\|cmd), script(workDir 相对路径), args_schema?, example? }` |
| **存储** | `<workDir>/.brain/workspace-tools.json`（`{ tools: WorkspaceScriptToolDef[] }`） |
| **校验** | 脚本存在且在 workDir 内；name slug 化 + 强制 `ws_` 前缀；同名替换（version 不做，覆盖即可） |
| **materialize** | 每次 RUN 派发 baseNode 时 `materializeWorkspaceScriptTools(workDir)` → `Tool[]`，注入 allowlist（在核心工具之后，`ws_` 前缀保证不覆盖） |
| **执行** | `ws_<name>` 工具入参 `args`（追加到命令行）；`runCommand(interpreterBin + script + args, { cwd: workDir })`；env 继承（同 shell_exec） |
| **Designer 可见** | `buildUserMessage` 增「## 已注册工作区工具」清单；Designer 在 instruction 里可让 baseNode 直接调 `ws_*`，避免重复 ReAct |

**与 node_creator 的关系**：`node_creator` 固化 **图上的格子（认知单元）**；`register_workspace_script_tool` 固化 **allowlist 里的原子能力（执行单元）**。两者互补，不互替。

---

## 8. compound 节点的执行语义

> 与 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §2 同步。

```text
LocalNode.body.graph 存在时（compound）:
  Runner: 展开 inline 子图执行（与 DyFlow flat operator 一致）
  Designer: 视作认知黑盒（只看 interface + description）
  失败传播: 子图任一 node terminal failure → 父图视为 terminal
  memory: 子图共享父图全局 memory，按 NodeDef.exports 暴露顶层 key
```

不做 *执行黑盒*（避免 trace 不可审计，与「调试展开 / 生产黑盒」二元方案不同）。

---

## 9. Designer Tools（DESIGN 阶段调用）

> Designer tools 与 baseNode tools **隔离 allowlist**；运行时不可互调。

| Tool | 作用 | 实现位置 |
|------|------|---------|
| `list_local_nodes` | 列本 workDir LocalNode 摘要（id + description + tags） | `inner-brain/designer-tools/list-local-nodes.ts` |
| `read_local_node` | 读单个 LocalNode 完整 JSON | `…/read-local-node.ts` |
| `read_memory` | 按 key 读 memory（含 last_failure） | `…/read-memory.ts` |
| `read_trace` | 读最近 N 轮 baseNode 执行 trace 摘要 | `…/read-trace.ts` |
| **`search_and_instance`** | drive9 搜 NodeDef → 批量 Assembler → 只回报成功 LocalNode | `…/search-and-instance.ts` |
| `commit_local_dag` | Designer 出图终态（写 `local_dag.json`） | `…/commit-local-dag.ts` |
| `report_done` | Designer 宣告本 burst 完成（→ DONE） | `…/report-done.ts` |

**P0**：先实现 `list/read_local_node/read_memory/commit_local_dag/report_done`；`search_and_instance` 在 P1。  
**P2**：可加 `query_kpi_progress`、`read_environment`（外脑 environmentJournal 视图）。

详见 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §4 关于 `search_and_instance` 的契约。

---

## 10. preset LocalNode（系统 seed）

```text
首次 spawn / 缺失时:
  worker 启动 → seedPresetNodes(workDir)
  → .brain/local_nodes/preset/*.json
```

| preset id | 类型 | P 阶段 |
|-----------|------|--------|
| `preset/base` | baseNode 通用模板（默认 prompt + 全工具 allowlist） | **P0** |
| `preset/node_creator` | newNodeCreator | **P0** |
| `preset/extract_facts` | baseNode（工具：read_trace + write memory.facts） | **P2** |

预置节点 **不**自动 export（Abstractor 跳过 source=preset）。

---

## 11. 知识 / 红线 的迁移路径

> 与 [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md)（已更新）同步。

| 旧载体 | 新载体 | 迁移说明 |
|--------|--------|---------|
| `.brain/knowledge.md`（事实 prose） | `memory.facts[]` + drive9 `/knowledge/shared/` seed | extract_facts preset（P2）；外脑 seed 仍可直接灌入 memory |
| `.brain/constraints.md`（红线 prose） | `memory.constraints[]`（外脑 set_goal / KPI policy 写）+ LocalNode 战术约束（Creator 进 prompt） | 全局 KPI 红线由外脑写 memory；战术红线走 LocalNode |
| `.brain/skills/` + `skills.md`（write_skill） | LocalNode + NodeDef | 不再单独存在；Creator 打包替代 write_skill |
| `.brain/milestones.md` | **删** | Designer 自由编排，无 milestone checklist |
| `.brain/execution-context.json` | `memory.json` + `memory.last_failure` | Attributor 已废 |

---

## 12. burst 生命周期 & 跨 burst 复用

```text
burst 结束 → registry DONE；子进程退出
  保留:
    .brain/local_nodes/   ← 战术节点库（复用）
    .brain/local_dag.json ← 末轮图（debug + 重开 seed）
    .brain/memory.json    ← 摘要
    .brain/trace/         ← N 天滚动
    workDir 脚本 / artifacts
  不清:
    除非外脑显式 cull / KPI 切换 canonical instance
```

**同 KPI 重开**（与 [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md) R1/R3 对齐）：

```text
外脑 spawn 同 instance
  → worker 启动
  → DESIGN 直接读已有 LocalNode 库 + memory + last_failure
  → 不走 import；不走 Creator 重新打包
```

跨 KPI / 跨 agent 共享 → drive9 NodeDef，详见 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §4–§6。

---

## 13. ADL 组件（与 `inner-worker.dsl` 同步）

> 旧 `decomposer / executor / attributor / blockResolver` 在 P0 落地后退役；DSL 中标 `Deprecated` 标签直至代码删除。

| 模块 ID | 职责 | 主路径（计划） | 测试 |
|---------|------|----------------|------|
| **innerBrainController** | 新 FSM（DESIGN/RUN/AWAITING/DONE）| `openkuroneko/inner-brain/controller.ts` | ⏳ `innerBrainController.component.integration.test.ts` |
| **designer** | DESIGN 阶段 LLM + Designer Tools | `…/designer.ts` | ⏳ `designer.component.integration.test.ts` + `.prompt.test.ts` |
| **runner** | RUN 阶段：解析 `local_dag`，按 NodeInst 派发 baseNode / Creator | `…/runner.ts` | ⏳ `runner.component.integration.test.ts` |
| **baseNodeExecutor** | 单个 baseNode 的 LLM+tools ReAct（含 failure_summary 写入） | `…/base-node-executor.ts` | ⏳ `baseNodeExecutor.component.integration.test.ts` |
| **nodeCreatorExecutor** | newNodeCreator 节点执行（pack / specialize） | `…/node-creator-executor.ts` | ⏳ + `.prompt.test.ts` |
| **localNodeStore** | `.brain/local_nodes/*.json` 读写 + index | `…/local-node-store.ts` | ⏳ |
| **memoryStore** | `.brain/memory.json` 读写 + last_failure / facts / constraints / node_results | `…/memory-store.ts` | ⏳ |
| **designerToolRegistry** | Designer 专用工具集装配 | `…/designer-tools/index.ts` | ⏳ |
| **presetSeeder** | 首次 spawn 注入 `preset/*` 节点 | `…/preset-seeder.ts` | ⏳ |

外脑侧新增 / 受影响：见 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §7。

---

## 14. 实施阶段

| 阶段 | 范围 | 出口 |
|------|------|------|
| **P0（替换内核）** | 新 FSM + designer + runner + baseNodeExecutor + nodeCreatorExecutor + localNodeStore + memoryStore + presetSeeder（仅 base/node_creator） | 单 KPI 跑通 DESIGN↔RUN |
| **P1（节点共享）** | `nodeAbstractor` auto-export + `nodeDefDrive9Store` + `nodeAssembler` + `search_and_instance` + dedupe/quota | 跨 burst 共享 LocalNode → drive9 → 装配 |
| **P2（事实层 + 治理）** | `preset/extract_facts` + `nodeDefEviction`（外脑 sweep）+ memory.facts seed 路径 | 删除 `write_knowledge / write_constraint / write_skill` 工具与对应 BrainFS 接口 |

> **已完成（2026-06-02）**：旧三件套代码与 ADL 全部删除，`INNER_BRAIN_ENGINE` flag 移除，DyFlow 成为唯一引擎。`write_knowledge / write_constraint / write_skill` 工具已删，事实改走 `record_fact / record_constraint`。

---

## 15. 与现有 ADL 的衔接

| ADL 文件 | 影响 |
|---------|------|
| [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md) | 不变。canonical instance 概念被 DyFlow burst 重开机制完全继承 |
| [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md) | `mode` 列表更新：增加 `DESIGN/RUN/DONE`；`is_post_complete` 触发条件改为 Designer DONE 或 `memory.kpi_progress` |
| [`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md) | 不变。peer 互读仍由 workdirGuard + .inbox/ 提供 |
| [`INNER-FILE-ACCESS.md`](./INNER-FILE-ACCESS.md) | 不变。read_file 分页仍 ⏳ |
| `INNER-EXECUTE-INCREMENTAL.md` | **已删除**（旧 Executor 增量模型随三件套移除） |
| [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) | 增 drive9 `/nodes/shared/` 行；`knowledge.md / constraints.md / skills/` 标 deprecated |
| [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md) | 旧三件套行已删；新增 completionReport 行 |

---

## 16. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-02 | 初版：Designer–Runner 替换三件套；DESIGN/RUN/AWAITING/DONE FSM；NodeInst schema；failure_summary；Designer Tools；preset；burst 全保留 |
| 2026-06-02 | §6.1：baseNode fail-fast streak + `INNER_BASE_NODE_MAX_ROUNDS`（bot2 实验：7×50 轮 safety_cap 烧 token）|
| 2026-06-02 | §7b：固化三层（facts/LocalNode/**Tool**）+ 晋升准则；T0 `register_workspace_script_tool`（bot2：成功节点 0 提升，且多数应是 Tool 非 Node）|
