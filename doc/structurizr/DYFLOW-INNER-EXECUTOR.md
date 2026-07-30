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
dyflow-state.json mode:
  DESIGN → RUN → ATTRIBUTE → DESIGN | AWAITING → DONE
```

| mode | 动作 | 谁主导 |
|------|------|-------|
| **DESIGN** | 读 goal + memory + last_failure + LocalNode index → 调 Designer Tools → 写 `local_dag.json` 或宣告 DONE | Designer LLM |
| **RUN** | 顺序/依边走 `local_dag`；按 NodeInst 派发 baseNode / newNodeCreator；结束写 `run-context.json` | Runner（无 LLM 决策）|
| **ATTRIBUTE** | 读 run-context → Mandatory Attributor 写 `memory.facts` / `constraints` → 清 run-context；失败叠加 failure-distill | Attributor LLM（见 [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md)） |
| **AWAITING** | `pendings.json` 等 timer / human；与 [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md) §4–§6 一致 | 外脑 changeWatcher / awaitingInboundResolver |
| **DONE** | 子进程退出；registry **DONE**；同 KPI canonical instance 可由外脑再 spawn | controller 自报 + 外脑 KPI 判定 |

转移规则（与 `registryLifecycleReconcile` 对齐）：

```text
DESIGN    → RUN          : Designer 输出 local_dag 非空
DESIGN    → DONE         : Designer 自报「目标已完成」 / `memory.kpi_progress` 已满
DESIGN    → AWAITING     : local_dag 含 wait_timer / ask_user
RUN       → ATTRIBUTE    : 图跑完（成功或失败）；持久化 run-context
ATTRIBUTE → DESIGN       : 归因完成；无 active pendings
ATTRIBUTE → AWAITING     : 归因完成；有 pendings
AWAITING  → DESIGN       : pendings 全部 resolved/timed_out；changeWatcher spawn 前 `markConsumed`（见 IM-NOTIFY-BOUNDARY §6–7）
DONE      → DESIGN       : 同 instance 再 spawn（外脑 KPI 未完成）
任意     → ERROR/STOPPED : 同旧 FSM
```

旧 mode 映射（删除时清单）：

| 旧 mode | 处理 |
|--------|------|
| `DECOMPOSE` | **删** — 不再有 milestones |
| `EXECUTE` | → `RUN`（内核语义不同：猛猛干，无早停） |
| `ATTRIBUTE` | **恢复（DyFlow）** — RUN 后强制归因；`run-context.json` 替代 legacy `execution-context`；详见 [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md) |
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
  acceptance?:  NodeAcceptance     # 可选；缺省按 LocalNode.interface.outputs 机械验票（§6.7）
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

## 6. baseNode：执行到位 + 尽早上交

### 6.1 执行约定

```text
baseNode（preset/base 或 Creator 派生）
  Runner 入口:
    prompt = systemSlice(LocalNode.body.executor.promptTemplate)
           + userSlice(memory + goal + NodeInst.instruction?)
    tools  = LocalNode.body.executor.tools  (allowlist)
    LLM ReAct loop（prompt 鼓励**尽早上交**，框架 fail-fast / 轮次上限兜底）
      工具失败 → **有限**自救（改参 / 换一条路径各试一次）；同模式重复 2～3 次 → 鼓励 CANNOT_CONTINUE
      **连续无进展**（默认 5 轮内无任何 `ok:true` 工具结果，`INNER_BASE_NODE_FAIL_FAST_STREAK`）→ transient `last_failure`，上交 Designer（可由 Designer 安排重试）
      **绝对轮次上限**（默认 50，`INNER_BASE_NODE_MAX_ROUNDS`）→ 同上 transient；无进展仍由 fail-fast（5 轮）提前上交 Designer
      达到「不可继续」判定 → 写 failure_summary，退出
      达到目标 / interface.outputs 全部满足 → ok 退出
```

**禁止**：

- baseNode 内部生成新 LocalNode（那是 newNodeCreator 职责）
- baseNode 改 `local_dag`（那是 Designer 职责）
- baseNode 跨 NodeInst 读写 memory **未声明** key（除 last_failure）

### 6.1b 运行时上下文（Runtime Context，P0）

> 对齐 Cursor [agent harness](https://cursor.com/blog/continually-improving-agent-harness) / OpenCode prompt assembly：**稳定、每节点必带**的执行环境事实，减少 ReAct 在 OS/shell/凭据路径上的无效试探。

`baseNodeExecutor` 在 **system prompt 末尾**（`LocalNode.body.promptTemplate` 之后）追加 `## 运行时环境`，内容来自 `inner-brain/runtime-context.ts`：

| 字段 | 来源 | 说明 |
|------|------|------|
| `platform` / `arch` | `process.platform` | `win32` / `linux` / `darwin` |
| `shell` | `UTLRA_SHELL` + `exec-runner` | Windows 默认 `powershell`（`-Command`）；`cmd` 可显式回退 |
| `user` / `home` | `os.userInfo` / `HOME` | 路径推断用 |
| `workDir` | NodeInst / ctx | 相对路径基准 |
| `dataRoot` / `vault` | `UTLRA_DATA_ROOT` | `vault/blocks/keychain` 凭据根；**无 dataRoot 时注明 vault 不可用** |
| `env_keys` | `process.env` 名列表 | 仅列 **存在** 的 key 名（含 `*_API_KEY` / `*_SECRET`），**不含 secret 值** |
| 凭据契约 | 固定文案 | **以 NodeInst.instruction / memory.goal 中的明文为准**；勿默认挖 vault/浏览器；**禁止** Edge 解密、macOS `security`、bash `||` 在 PowerShell 中 |

**与上下文治理**：runtime 块随 system 前缀固定；ReAct 历史治理见 §6.5。

实现：`buildRuntimeContextSection({ workDir, dataRoot? })` · 测试：`runtime-context.test.ts`。

### 6.1d 资源预算披露（ResourceBudget，P0）

> **动机**：仅框架硬截断（`safety_cap`）时 LLM 无轮次感知，易烧满预算；静态「最多 N 轮」写在首轮 prompt 会被长 ReAct 历史淹没。

`inner-brain/resource-budget.ts` 统一读取 env，向 LLM **同时披露硬上限与当前用量**：

| 角色 | env | 默认 | 披露方式 |
|------|-----|------|----------|
| **baseNode** | `INNER_BASE_NODE_MAX_ROUNDS` | 50 | system 静态块 + **每轮** 覆写首条 user 前缀（`upsertLiveBudgetMessage`） |
| **baseNode fail-fast** | `INNER_BASE_NODE_FAIL_FAST_STREAK` | 5 | 同上，含「连续无进展 X/Y」 |
| **Designer** | `INNER_DESIGNER_MAX_ROUNDS` | 20 | system 静态块（含单格 baseNode 预算提示）+ 每轮 live |
| **Attributor** | `INNER_ATTRIBUTOR_MAX_ROUNDS` | 20 | system 静态块 + 每轮 live |

**live 块内容**（每轮覆盖上一条，marker `## 资源预算（框架实时）`）：

- `ReAct 轮次：k / max（pct%）`
- `本阶段工具调用：n 次`
- baseNode 另含 `连续无进展：streak / failFast`
- **软阈值文案**：≥60% 提示收束；≥80% 强调；≥90% 紧急（写交付 / `CANNOT_CONTINUE(transient)`）

**硬截断不变**：框架仍执行 `safety_cap` / `fail_fast`；披露是引导收束，非替代闸门。

实现：`resolve*Budget()` · `buildStaticResourceBudgetSection()` · `buildLiveResourceBudgetSection()` · `upsertLiveBudgetMessage()` · 测试：`resource-budget.test.ts`。

### 6.1c 凭据传递链（P0，修正 keychain 语义）

> vault **不是**内外脑加密信道，是外脑侧**独立保管**，防止凭据在长上下文丢失。执行时靠 **明文 task 传递**。

```text
外脑 keychain_put → 外脑 keychain_get → set_goal（goal 正文含明文）
  → memory.goal → Designer NodeInst.instruction（明文摘录）
  → baseNode 按 instruction 执行（不默认 shell/Edge 挖密码）
```

| 角色 | 职责 |
|------|------|
| **外脑** | 需要派活时 `keychain_get` 取明文，**写入 `set_goal` 的 goal 参数**（勿只在 IM 说「已存 keychain」） |
| **Designer** | 子目标需要账号时，从 `memory.goal` / constraints **把明文写进 `instruction`**，不要写「去读 keychain」让 baseNode 猜 |
| **baseNode** | 信任 instruction 中的明文；禁止浏览器解密/env 盲探 |

**内脑兜底工具**（非主路径）：`keychain_entries` / `keychain_get`（`keychain-tools.ts`），仅 instruction 明确要求读 vault 且 goal 无明文时用。无 `keychain_put`。

`preset/base` v1.2.0：凭据以 instruction 明文为主；v1.1.0 的「优先 keychain_get」已废弃。

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

### 6.7 节点完成判定与验票（P0b，2026-06-03）

> **动机**：旧 Executor 有 Attributor 验票；DyFlow 迁移后 LLM 停工具即 `collectOutputs(lastContent)`，**无产物校验** → 404 shell、已有数据仍探索、safety_cap 仍记「跑完」。

**原则**：LLM 只负责探索/编排；**完成四态由 Runner + 机械验票**决定，不交给 Designer 主观猜。

| 状态 | 含义 | 写入 |
|------|------|------|
| `ok` | `interface.outputs`（或 `NodeInst.acceptance`）全部验票通过 | `node_results[id].ok=true`, `status=ok` |
| `failed` | 高置信不可恢复 / 输出契约缺失 / 假 shell 成功累计 | `last_failure` + `status=failed` |
| `capped` | 达 `INNER_BASE_NODE_MAX_ROUNDS` 仍未收敛 | `last_failure`（transient）+ `status=capped` |
| `partial` | （P1）显式 `acceptance.minOutputs` 满足但未全量 | `status=partial`；默认 P0 不启用 |

```text
baseNode 自然结束（无 tool_calls）时:
  1. gatherEvidence(executionLog, workDir) — write_file/read_file/shell 路径与产物
  2. validateNodeCompletion(node.interface.outputs, evidence, lastContent)
  3. 任一 mandatory output 未通过 → terminal failure「输出契约未满足」
  4. 通过 → ok + outputs（证据值优先于 lastContent 占位）

ReAct 循环内（每轮）:
  shell_exec 若 ok:true 但输出含 HTTP 404 / exit code≠0 等 → 降为 ok:false（shell-evidence）
  避免「curl 404 仍算有进展」烧满 safety_cap
```

**`NodeInst.acceptance`（可选）**：

```text
NodeAcceptance {
  requireAllOutputs?: boolean   # 默认 true
  minOutputs?: string[]         # P1：至少满足的 output key 子集 → partial
}
```

**`interface.outputs[].type` 验票规则（P0）**：

| type | 通过条件 |
|------|----------|
| `string` | `lastContent` 非空摘要，或 executionLog 有 ok 工具且非纯失败占位 |
| `file` | workDir 内相对路径存在（来自 evidence 或 LLM 声明路径） |
| `json` | 同上且 `JSON.parse` 成功；可选检查顶层 `code===0`（番茄类 API 通用，非案例硬编码） |

实现：`inner-brain/node-acceptance.ts` · 测试：`node-acceptance.test.ts`。

### 6.7a 节点级交付物 `NodeInst.deliverable`（机械验票，替代旧里程碑交付要求）

> **动机（bot2 `ib-mq13z7co-9420`）**：`preset/base` 的 `interface.outputs` 只有松散的 `result: string`（≥8 字符即过），导致「番茄建书」节点 `rawTail` 喊「创建成功」却被判 `capped`、而后续节点凭空断言「已发布 5 章」也无人验。**根因**：缺少 Designer 在编排时就为每个节点声明「这一格必须交付什么、怎么机械验」。旧固定流程靠里程碑给出明确交付要求；DyFlow 用 `NodeInst.deliverable` 把这份要求**下沉到节点**。

**schema（`types.ts`）**：

```text
DeliverableCheck {
  kind:     'file' | 'json_key' | 'stdout_contains' | 'stdout_absent'
  target:   string   # file: workDir 相对路径；json_key: "rel.json#a.b.c"；stdout_*: 子串
  describe?: string   # 人类可读：这条代表什么
}
NodeDeliverable {
  summary: string             # Designer 一句话说清本节点必须交付什么
  checks:  DeliverableCheck[] # 全部通过才算节点 ok（与 interface.outputs 取 AND）
}
NodeInst.deliverable?: NodeDeliverable
```

**验票规则**：

| kind | 通过条件 |
|------|----------|
| `file` | workDir 内相对路径存在、是文件、size>0（路径解析见下「路径规范」） |
| `json_key` | `rel.json` 存在且 `JSON.parse` 成功，且 `#` 后点路径解析到非 null/undefined（数组/字符串需非空） |
| `stdout_contains` | 本节点 executionLog 聚合 stdout（所有 `shell_exec` 输出 + lastContent）**包含** target 子串 |
| `stdout_absent` | 同上 stdout **不含** target（捕捉 `404`/`error`/`失败` 等假成功信号） |

- `deliverable` **存在时**：节点 ok ⟺ `interface.outputs` 机械验票通过 **且** 全部 `checks` 通过；任一 check 失败 → `status: failed`，`missing[]` 列出失败 check 的 `describe`/`target`。
- `deliverable` **缺省时**：退化为原 §6.7 行为（仅 `interface.outputs`）——向后兼容（历史图 / 非 Designer 路径）。
- 共享引擎：`inner-brain/deliverable-check.ts`（`runDeliverableChecks`），同时被 `node-acceptance.ts` 与 Designer `report_done` 闸门（§9a）复用。

**P-prompt（2026-07-25 · kuroneko `ib-ms07nqqi-d102`）**：`baseNodeExecutor.buildUserMessage` **必须**注入 `NodeInst.deliverable`（summary + 每条 check 的 `kind`/`target`/`describe`），使 RUN 时 LLM 看见与机械验票相同的口令/路径。**禁止**用同义成功词（如 `ALL_CHECKS_PASSED` vs `FILES_READY`）软放过——验票牙齿不变，只补「执行侧知情」。编排偏好：能用 `file` / `json_key` 就不要只靠自创 `stdout_contains` token；若用 stdout token，须在 `instruction` 与 `checks.target` 写同一精确子串。

**路径规范（2026-07-22 · 假阴性验证）**：

> 生产验证见 [`DELIVERABLE-PIPELINE-GAPS.md`](./DELIVERABLE-PIPELINE-GAPS.md) **Gap B**。现行实现多为字面 `path.join(workDir, target)`，易在「声明 `workspace/X`、落盘为根下 `X`」时误杀。

| 规则 ID | 要求 |
|---------|------|
| **P-alias** | `kind=file` 与 `interface.outputs[].type=file`：候选路径含声明 `target`、去/加 `workspace/` 前缀的同名相对路径；**任一**存在且 size>0 → 通过 |
| **P-rel** | `commit_local_dag`：**拒收**绝对路径或含 `..` 的 `checks.target` / file 输出声明（与 `inner-brain-deliverables` R2.4 对齐） |
| **P-clear** | 节点终态 `ok` 时清除或归档本节点导致的 sticky `memory.last_failure`，避免后续轮次误读「永远契约失败」 |
| **P-evidence** | 成功 `shell_exec` / 写文件工具留下的相对路径须进入 `gatherEvidence`，与 `register_deliverable`（管外脑回传）互补 |

**`commit_local_dag` 编排期硬约束（2026-06-06，bot2 `ib-mq1vvq2p-3165` 实测驱动）**：实测 16 节点约 10 个 `capped`，Designer 反复发 `preset/base` + **巨型单体 instruction**（把整段 Playwright 脚本 + 2000 字小说正文塞进 `instruction`，等于 Designer 替 baseNode 干活让其复制粘贴），且 DESIGN 一轮耗时 20 分钟。`commit_local_dag` 两条机械拒收：

1. **anti-monolith**：任一 `instruction.length > 4000`（`MAX_INSTRUCTION_CHARS`）→ 拒收。instruction 只写「战术方向 + 关键事实 + deliverable」；完整脚本/长正文由 baseNode 自己 ReAct 生成，或在 facts 记脚本路径后 `shell_exec` 跑。
2. **mandatory deliverable**：任一节点缺 `deliverable` 或 `checks` 为空 → 拒收（落实「给目标也要给明确交付要求」）。

实现：`inner-brain/deliverable-check.ts` + `node-acceptance.ts` + `designer-tools.ts`（`commit_local_dag` 守卫）· 测试：`deliverable-check.test.ts` / `node-acceptance.test.ts` / `designer.test.ts`（超长 / 缺 deliverable 拒收后恢复）。

### 6.8 DAG 记忆 `memory.dag_history`（patch vs redesign 的依据）

> **动机**：Designer 旧实现只看 `node_results`（当前键值）与 `last_failure`，**看不到「过去几轮各自排了什么图、整体成没成」**。结果要么反复 redesign 同一张已大半成功的图（浪费 + 抖动），要么意识不到某条路线已连续失败、仍在原地打转。旧固定流程靠人定的串行步骤天然「记得」走到哪；DyFlow 需把这份「计划序列记忆」显式化。

每轮 RUN 结束，controller 把本轮 committed DAG + 执行结果归档进 `memory.dag_history`（环形，保留最近 `INNER_DAG_HISTORY_MAX`，默认 20）：

```text
DagHistoryEntry {
  burstId, designedAt, finishedAt
  ok: boolean              # 整图是否全绿
  failedAt?: string        # 失败 nodeInstId
  nodes: { id, ref, instruction?(截断), status: ok|partial|capped|failed|pending, deliverable?(summary) }[]
  notes?: string
}
InnerMemory.dag_history?: DagHistoryEntry[]
```

`buildUserMessage` 注入「## 最近 DAG 历史」摘要，Designer 据此做 **patch vs redesign 决策**：

```text
- 上轮图大部分 ok、仅个别节点 failed/capped  → patch：只重排失败的那一格（换 ref / 新 instruction），保留已 ok 的格子，勿整图重来
- 同一路线连续 ≥2 轮整体失败 / 根因在编排结构    → redesign：换思路重排整图
- 某子目标已在历史中 ok 且产物仍在               → 视为已锁定，勿重复编排（里程碑锁定的轻量形态）
```

实现：`memory-store.ts appendDagHistory` + `controller.ts`（RUN 后归档）· 测试：`memory-store.test.ts`。

### 6.5 ReAct 上下文治理（P2）

> 不做 LLM 整段摘要 compaction（易丢约束、伤 cache）；采用 **截断 + 落盘 + 旧轮 prune**，结论仍应 `record_fact` 沉淀。

| 机制 | 实现 | 默认 | 环境变量 |
|------|------|------|----------|
| **Tool 输出压缩** | `tool-output-spill.ts` | 超 `INNER_TOOL_OUTPUT_INLINE_MAX`（3000）→ head/tail + 全文写入 `.run/tool-output/` | `INNER_TOOL_OUTPUT_INLINE_MAX` |
| **旧轮 prune** | `react-message-prune.ts` | 保留首条 `user` + 最近 **2** 轮完整 tool；更早轮 tool → `[react-prune]` 占位（含落盘路径提示） | `INNER_REACT_PRUNE=1`，`INNER_REACT_PRUNE_PROTECT_ROUNDS=2`，`INNER_REACT_PRUNE=0` 关闭 |
| **Tool 参数瘦身（P2.5）** | `react-tool-call-slim.ts` + `write-content-guard.ts` | 仅**保护窗口外**旧轮 assistant 参数替换为 `__SLIM_REF__:<path>`（非人类/模型可复述格式）；**最近 N 轮保留完整 write/edit 参数**；禁止把 slim 占位或 `__SLIM_REF__` 写入磁盘 | `INNER_TOOL_ARGS_SLIM_MIN=200`，`INNER_REACT_PRUNE_PROTECT_ROUNDS=2` |
| **write_file 同路径保护** | `base-node-executor.ts` | 节点内同路径首次 `overwrite` 成功后，再次 `overwrite` 拒绝（须 `edit_file` 或 `append`）；失败可重试 | — |
| **web_search fetch 上限** | `web-search/index.ts` | 默认 **4000** 字符（`truncatePage`）；可 `max_chars` / `OPENKURONEKO_WEB_SEARCH_FETCH_MAX_CHARS` | — |
| **Shell stall** | `shell-stall-guard.ts` | 同一 `shell_exec` 命令连续 **4** 次 `ok:false` → transient failure | `INNER_SHELL_STALL_GUARD=1`，`INNER_SHELL_STALL_MAX_REPEAT=4` |
| **Burst stall alert** | `burst-stall-evaluator.ts` + `burst-stall-alert.ts` | 多节点 cap / 无 facts / 长跑无 deliverable → **立即** `DATA_ROOT/stall-alerts/` 定位包 + Dashboard | [`INNER-BURST-STALL-ALERT.md`](./INNER-BURST-STALL-ALERT.md)；`INNER_BURST_STALL_ALERT=1` |
| **Prompt cache 计量** | `llm-usage-types.parseLlmUsageFromResponse` | journal 可选字段 `cachedPromptTokens`（`prompt_tokens_details.cached_tokens`） | — |

**禁止**：prune 后不自动删 `.run/tool-output/`（本轮 burst 内可 `read_file` 复查）；**不**改写 system / 首条 user。

**P1（✅）**：`read_file(offset_line,limit_lines)` / `read_peer_file` 分页（`read-file-lines.ts`）· `shell_probe` 批量探测（§6.6）。

### 6.6 shell_probe（P1）

| 项 | 说明 |
|----|------|
| **目的** | 多条只读探测命令一次 tool 返回，减少 ReAct 轮次（凭据/环境发现） |
| **实现** | `tools/definitions/shell-probe.ts`；注册于 `run-tick.ts` executor 工具集 |
| **参数** | `commands`（JSON 数组或换行分隔，最多 8）、`stop_on_first_ok`（默认 true）、`timeout_ms`（默认 15000） |
| **行为** | 顺序 `runCommand`；首个 exit 0 且非空输出可提前结束 |
| **提示** | `runtime-context.ts` + preset 约束：环境探测优先 `shell_probe`，大文件用分页 `read_file` |

### 6.6b 浏览器会话工具（P0，2026-06-07）

> **动机**：`shell_exec` 跑自写 Playwright 脚本 = 每次全量 launch/close；弹窗等中间态无法续跑。专篇 [`BROWSER-SESSION-TOOL.md`](./BROWSER-SESSION-TOOL.md)。

| 工具 | 职责 |
|------|------|
| `browser_open` | 创建 `session_id`；可选 cookies/storage_state |
| `browser_act` | 增量 `goto` / `click` / `fill` / `screenshot` / `snapshot` / … |
| `browser_close` | 释放 session |
| `browser_list` | 列出本 workDir 活跃 session |
| `browser_run_steps` | 内联 `steps` 或 `playbook` JSON 顺序执行（脚本化，同 session 增量） |

**生命周期**：`runBaseNode` 任意退出路径 → `closeSessionsForNode(nodeInstId)`。UI 自动化禁止 monolithic Playwright 脚本（preset §浏览器）；稳定路径用 playbook + `record_fact`。

### 6.4 内脑工具审计（baseNode / Designer）


DyFlow 每次工具调用落盘 JSONL，便于按节点分析 token 与行为（对齐外脑 `outer/tool-logs`）：

```text
DATA_ROOT/inner/tool-logs/<workspaceId>/YYYY-MM-DD.jsonl
```

| 字段 | 说明 |
|------|------|
| `schema` | `inner-tool-audit.v1` |
| `module` | `base-node` \| `designer` \| `node-creator` |
| `event` | `tool.call` \| `tool.result` |
| `data.round` | ReAct 轮次（0-based） |
| `data.name` | 工具名 |
| `data.node_inst_id` | NodeInst.id（baseNode） |
| `data.burst_id` | KPI burstId |
| `data.args` | 脱敏参数（长 `content` 截断） |
| `data.preview` | 结果预览 ≤240 字符 |
| `data.output_len` | 完整输出长度 |

实现：`inner-brain/inner-tool-audit.ts`；`base-node-executor` 在每次 `tool.call` 前后写入。

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

## 7. 节点提升（已迁出 RUN 阶段 → §9b）

> **2026-06-06 移除 `preset/node_creator` RUN 节点**（见 §16）。旧设计把「节点提升」做成图里的一格（baseNode 特化，tools 仅 `commit_local_node`，`mode=pack|specialize`），bot2 实证 Designer 极少主动排它（首跑 9 个成功节点 0 提升）——提升本是「反思」职责，却被塞进「执行」阶段。

提升统一改走 Designer DESIGN 阶段工具 **`promote_local_node`**（见 [§9b](#9b-designer-反思与节点提升promote_local_node)）：当轮直接反思 + 固化，无需多排一格 ReAct。auto-export（drive9 节点共享）随之迁到 `promote_local_node` 成功路径上（fire-and-forget），不再依赖 Runner。

**修复**：修复走 NodeInst.instruction（Designer 写战术）+ 必要时 `promote_local_node` 把成功修复路径打成新版本（dedupe + version bump，见 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §6）。

---

## 7b. 固化的两层：facts / LocalNode（晋升准则）

> bot2 首跑（`ib-mpwfiv02-2887`）暴露：9 个成功节点全是 `preset/base`，**0 提升**。曾设过第三层「Tool 晋升」（`register_workspace_script_tool` → `ws_*`），但生产从未触发（注册 0 次、调用 0 次），徒增 Designer 清单 / runner 注入 / manifest 维护成本。**2026-06-06 已移除**（见 §16）。稳定脚本改由 `record_fact` 记「路径 + 怎么跑」，baseNode 继续 `shell_exec` 执行。

「成功经验」固化为两种形态，**成本递减、确定性递增**：

| 层 | 载体 | 谁调用 | 成本 | 适用 |
|----|------|--------|------|------|
| **A 事实** | `memory.facts` / `fact_records`（`record_fact` / `preset/extract_facts`） | Designer / baseNode 读上下文 | 读 | 知识、选择器、API 形状、账号归属、**稳定脚本路径 + 运行方式**；**治理**见 [`FACTS-KNOWLEDGE-GOVERNANCE.md`](./FACTS-KNOWLEDGE-GOVERNANCE.md)（topic 合并 + 淘汰 + prompt 上限） |
| **B 节点** | LocalNode（`preset/node_creator` pack） | Designer 排 `ref: local/…`，**仍 LLM ReAct** | 中（prompt 更短，仍多轮） | **仍需临场判断分支 / 改参 / 组合多工具 / 解释失败** 的战术 |
| **C 工作流** | **Executable Workflow**（skills / playbook / frozen_dag …） | `burstMode=execute` + `workflowRef` | **高**（逐步 expect，禁 redesign） | 已知 SOP 重复执行；见 [`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md) |

**晋升判定（RUN 结束复盘按序问）：**

```text
1. 只是知识 / 选择器 / API 形状 / 稳定脚本路径？
     → A：record_fact / extract_facts（脚本写明「python workspace/foo.py 做 X」）
2. 战术仍要临场改参、组合多工具、解释失败？
     → B：node_creator pack / LocalNode
3. 路径已稳定、下次必须逐步照做、不许 redesign？
     → C：ATTRIBUTE **`promote_executable_workflow`** → Executable Workflow（之后 execute burst）
```

**谁晋升 C**：主路径是 **Mandatory Attributor**（与 `record_skill` 同阶段）；外脑 `workflow_promote` 仅人工补录/改版。不是「聊天偶然想起」才固化。
**反例（bot2 教训）**：登录 PS、查 ELO、跑 `ps_playwright_v6.py` 都属 **A**——脚本已落盘，用 `record_fact` 记路径即可，baseNode 下次 `shell_exec` 直接跑；而「据 last_failure 换对战格式」才是 **B**。

> **为什么不要「Tool 晋升」层**：把固定脚本声明成 `ws_*` 工具，省的只是「一次 `shell_exec` → 一次 `ws_` 调用」的微小差别，却要维护注册表、materialize、Designer 可见清单、路径穿越校验。bot2 实证零收益。固定脚本的「可复用」本质是**记住路径**（A 层 fact），不是再造一个工具名。

### 7c. FailureDistill（失败→红线，对称 §7b）

> **动机**：旧 Attributor 写 `.brain/constraints.md`；现仅有可选 `record_constraint`，**无每轮 RUN 后 mandatory 蒸馏** → Designer 下一轮仍排同错路径。

```text
RUN 结束（图失败或 terminal stop）→ 回 DESIGN 之前:
  failureDistill(memory, node_results[], last_failure)
    → 生成 1..N 条确定性 constraint 字符串（无 LLM）
    → memory.appendConstraint（去重）
    → Designer 下一 tick 必读 constraints（与 last_failure 并列）
```

| 蒸馏规则（P0 确定性） | 示例 constraint |
|----------------------|-----------------|
| 每个 failed `node_results` | `[run-failure] 节点 n3（preset/base）：…；禁止同 instruction 裸重试` |
| `safety_cap` / 安全轮次 | `[run-failure] ref preset/base 已 safety_cap，下轮须换 ref、API 或拆分节点` |
| 404 / not found 信号 | `[run-failure] HTTP/API 404 不得视为 shell 成功；须核对端点、鉴权、curl -L` |

**与 `record_constraint` 分工**：

| 机制 | 谁写 | 何时 |
|------|------|------|
| `record_constraint`（baseNode 工具） | LLM 自觉 | 探索中发现红线 |
| **FailureDistill** | Runner/controller **强制** | 每轮 RUN 失败后、进 DESIGN 前 |

P2 可增 LLM 摘要蒸馏（`preset/failure_distill`）；P0 仅规则引擎，避免再烧 token。

实现：`inner-brain/failure-distill.ts` · `controller.ts` RUN 分支调用 · 测试：`failure-distill.test.ts`。

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
| **`search_task_plans`** | 按 query 搜历史方案 / playbook（**参考 only**，不写 facts） | `…/designer-tools.ts` + [`TASK-PLAN-REFERENCE.md`](./TASK-PLAN-REFERENCE.md) |
| `commit_local_dag` | Designer 出图终态（写 `local_dag.json`） | `…/commit-local-dag.ts` |
| `report_done` | Designer 宣告本 burst 完成（→ DONE） | `…/report-done.ts` |

**P0**：先实现 `list/read_local_node/read_memory/commit_local_dag/report_done`；`search_and_instance` 在 P1。  
**P2**：可加 `query_kpi_progress`、`read_environment`（外脑 environmentJournal 视图）。

详见 [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §4 关于 `search_and_instance` 的契约。

### 9a. `report_done` 目标级闸门（防假完成）

> **动机（bot2 `ib-mq13z7co-9420`）**：`report_done` 旧实现只设 `session.doneReason`，controller 无条件转 DONE——Designer 一句「✅ 已发布 5 章」即终结，外脑收到的「完成」与磁盘真相相反。完成四态本应「Runner + 机械验票决定，不交给 Designer 主观猜」（§6.7），但 burst 终结这一步漏了机械关卡。

`report_done(reason, verify?)`：

| 参数 | 说明 |
|------|------|
| `reason` | 完成理由（人类可读） |
| `verify?` | `DeliverableCheck[]`——目标级交付证据（复用 §6.7a 引擎）。Designer 应为「交付型目标」列出可机械验的证据（产物文件存在 / JSON 含关键字段）|

**闸门规则**：

```text
1. verify 提供 → runDeliverableChecks(workDir, verify, stdout='')
     任一 fail → report_done 返回 ok:false（附失败明细），不转 DONE；
     Designer 必须继续 commit_local_dag 把缺口补齐后再报完成
2. verify 全过 / 未提供 → 接受，设 doneReason → controller 转 DONE
3. 未提供 verify 记 warning（交付型目标强烈建议提供）——不强制以免无产物目标死锁
```

teeth 主要来自 §6.7a 节点级交付物（杜绝节点假成功）；本闸门是第二层，确保「最终宣告」也要机械证据兜底。实现：`designer-tools.ts` `report_done` · 测试：`designer.test.ts`（verify 失败拒收 / 通过接受）。

### 9b. Designer 反思与节点提升（`promote_local_node`）

> **动机**：旧设计把「节点提升」做成一个 **RUN 节点**（`preset/node_creator`，Designer 需在图里排一格 `params.mode=pack`）。bot2 实证：Designer 极少主动排它（首跑 9 个成功节点 0 提升），因为提升是「反思」职责，却被塞进「执行」阶段，还要多花一格 ReAct。**改为 Designer 在 DESIGN 阶段直接反思 + 提升**。

新增 Designer 工具 `promote_local_node`（DESIGN 阶段直接调用，复用 `commit_local_node` 组装逻辑）：

| 维度 | 取值 |
|------|------|
| **何时调** | Designer 读 `node_results` / `dag_history`，发现一段战术已跑通且可复述、未来会复用 → 当轮直接提升（无需排 RUN 节点） |
| **入参** | `{ id, description, promptTemplate, tools, inputs?, outputs?, tags?, source_node_ids? }`（同 `commit_local_node`） |
| **效果** | 写 `.brain/local_nodes/<id>.json`（origin=creator）；P1 触发 auto-export。提升不终结 DESIGN——Designer 可继续 commit_local_dag 复用新节点 |
| **与 commit_local_dag 关系** | `promote_local_node` 是 DESIGN 内的副作用工具（像 read_memory），不构成终态；终态仍是 commit_local_dag / report_done |

**`preset/node_creator` RUN 节点已移除**（2026-06-06）：删除 `node-creator-executor.ts`、runner 的 `isCreatorNode` 派发、`PRESET_NODE_CREATOR` preset 与 seed；auto-export 迁入 `promote_local_node`（`sharing.sourceAgent` 提供时 fire-and-forget 触发 Abstractor）。提升统一走 `promote_local_node`。

**patch vs redesign**：不引入新模式枚举——`commit_local_dag` 已天然支持二者（只排失败那格 = patch；重排整图 = redesign）。决策依据来自 §6.8 `dag_history`，写进 Designer prompt（§6.3 失败决策表的补充）。

实现：`designer-tools.ts` `promote_local_node`（包 `createCommitLocalNodeTool`）· 测试：`designer.test.ts`。

### 9c. 里程碑锁定 `memory.locked_milestones`（机械防重排）

> **动机**：§6.8 dag_history 让 Designer「看得见」已完成子目标，但只是 prompt 自觉。更硬的隐患是 **`node_results` 以 `nodeInstId`(n1/n2…) 为键**——Designer 复用 id，后续轮会**覆盖**早期结果，于是已达成的子目标在 memory 里「消失」，Designer 重新编排它（重复登录、重复建书）。需要一份**不被覆盖**的持久「已完成」记忆 + 机械拦截。

**schema（`types.ts`）**：

```text
LockedMilestone { id, summary, lockedAt, evidence?: DeliverableCheck[] }
InnerMemory.locked_milestones?: LockedMilestone[]
NodeInst.milestone?: string   # Designer 给节点打的里程碑标签（它服务于哪个里程碑）
```

**Designer 工具 `lock_milestone(id, summary, verify?)`**：

| 规则 | 说明 |
|------|------|
| verify 提供 | 复用 §6.7a 引擎机械校验；不通过则**拒锁**（杜绝锁定未真正达成的里程碑）|
| verify 缺省 | 允许锁定但记 warning（非交付型里程碑）|
| 落点 | `memory.locked_milestones`（按 id 去重，replace）；side-effect 工具，不终结 DESIGN |

**机械拦截（`commit_local_dag`）**：任一 `NodeInst.milestone` 命中已锁定集合 → **拒收整图**，提示「该里程碑已锁定，勿重排；如需修补请换 milestone 标签或 unlock」。`buildUserMessage` 注入「## 已锁定里程碑（禁止重排）」清单。

> 锁定是 opt-in：Designer 主动给关键里程碑打标签 + 锁定才生效；不打标签的普通节点不受影响。锁定时的 verify 是机械的，拦截是机械的——比纯 prompt 自觉有牙齿。

实现：`memory-store.ts lockMilestone` + `designer-tools.ts` · 测试：`memory-store.test.ts` / `designer.test.ts`。

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
| **innerBrainController** | 新 FSM（DESIGN/RUN/ATTRIBUTE/AWAITING/DONE）| `openkuroneko/inner-brain/controller.ts` | ✅ `controller.component.integration.test.ts` |
| **dyflowAttributor** | RUN 后强制归因 | `openkuroneko/inner-brain/attributor.ts` | ✅ `attributor.test.ts` |
| **runContextStore** | RUN→ATTRIBUTE 快照 | `openkuroneko/inner-brain/run-context-store.ts` | ✅ `run-context-store.test.ts` |
| **designer** | DESIGN 阶段 LLM + Designer Tools | `…/designer.ts` | ⏳ `designer.component.integration.test.ts` + `.prompt.test.ts` |
| **runner** | RUN 阶段：解析 `local_dag`，按 NodeInst 派发 baseNode / graph | `…/runner.ts` | ⏳ `runner.component.integration.test.ts` |
| **baseNodeExecutor** | 单个 baseNode 的 LLM+tools ReAct（含 failure_summary 写入） | `…/base-node-executor.ts` | ⏳ `baseNodeExecutor.component.integration.test.ts` |
| **localNodeStore** | `.brain/local_nodes/*.json` 读写 + index | `…/local-node-store.ts` | ⏳ |
| **memoryStore** | `.brain/memory.json` 读写 + last_failure / facts / constraints / node_results | `…/memory-store.ts` | ⏳ |
| **nodeAcceptance** | baseNode 完成验票 + shell 假成功检测 | `…/node-acceptance.ts` | ⏳ `node-acceptance.test.ts` |
| **failureDistill** | RUN 失败→`memory.constraints[]` 强制蒸馏 | `…/failure-distill.ts` | ⏳ `failure-distill.test.ts` |
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
| 2026-06-02 | §6.1：`INNER_BASE_NODE_MAX_ROUNDS` 默认恢复 **50**；`INNER_BASE_NODE_FAIL_FAST_STREAK` 保持 **5** |
| 2026-06-02 | §6.4：内脑 `inner/tool-logs` 工具审计 JSONL（baseNode） |
| 2026-06-03 | §6.7：节点完成四态 + outputs 机械验票 + shell-evidence；§7c FailureDistill（RUN→DESIGN 前写 constraints） |
| 2026-06-06 | §6.7a：**`commit_local_dag` 编排期硬约束**——拒收 `instruction>4000字`（anti-monolith）与缺 `deliverable` 的节点；Designer 提示同步强化「拆小节点 + 必带交付物」。理由：bot2 ib-mq1vvq2p-3165 实测 16 节点≈10 capped、巨型单体 instruction、DESIGN 单轮 20min |
| 2026-06-06 | §7/§9b：**彻底移除 `preset/node_creator` RUN 节点**——删 `node-creator-executor.ts`(+test)、runner `isCreatorNode` 派发与 `RunnerDeps.autoExport`、`PRESET_NODE_CREATOR` preset/seed、`index.ts` 相关导出；auto-export 迁入 `promote_local_node`（`NodeSharingDeps.sourceAgent`，controller 注入，fire-and-forget）。理由：提升是反思职责不应占 RUN 格，bot2 首跑 0 提升，promote_local_node 已完全替代 |
| 2026-06-06 | §9c：**里程碑锁定 `memory.locked_milestones` + `lock_milestone` 工具 + `NodeInst.milestone` 标签**；`commit_local_dag` 机械拦截已锁里程碑重排。理由：node_results 按 nodeInstId 覆盖 → 已完成子目标"消失"被重做 |
| 2026-06-06 | §6.8：**DAG 记忆 `memory.dag_history`**（RUN 后归档 committed DAG + 结果，环形 20）→ Designer patch/redesign 决策；§9b：**`promote_local_node`** Designer 反思期直接提升节点，`preset/node_creator` RUN 节点标 deprecated |
| 2026-06-06 | §6.7a：**节点级交付物 `NodeInst.deliverable`**（file/json_key/stdout_contains/stdout_absent 机械验票，与 interface.outputs 取 AND）；§9a：**`report_done` 目标级闸门 `verify`**（复用同引擎，防 Designer 假完成）；新增 `deliverable-check.ts`；修复 `normalizeNodeInst` 丢弃 `acceptance` 的 bug。理由：bot2 ib-mq13z7co-9420「凭空断言已发布 5 章」终结 burst |
| 2026-06-06 | §7b：**移除「Tool 晋升」层（C）**——删 `register_workspace_script_tool` / `ws_*` / `workspace-script-tools.ts`；固化收成两层 facts(A)/LocalNode(B)；稳定脚本改 `record_fact` 记路径。理由：bot2 生产注册 0 次、调用 0 次，零收益却增维护成本。`doc/todo/dyflow-tool-promotion.md` 标 deprecated |
| 2026-06-08 | **内脑失败处理**：Designer LLM/空转 giveup → `dyflow-state.mode=ERROR`（不再 DONE+onComplete）；`resolveInnerBurstFinalStatus` → registry ERROR + `notifyInnerBrainTaskFailed` 短消息（不 dump seed facts） |
| 2026-07-22 | §6.7a：**路径规范** P-alias / P-rel / P-clear / P-evidence（交付物假阴性）；交叉验证 [`DELIVERABLE-PIPELINE-GAPS.md`](./DELIVERABLE-PIPELINE-GAPS.md) Gap B；测项 ⏳ |
| 2026-07-25 | §6.7a：**P-prompt**——`buildUserMessage` 注入 deliverable checks（防「活干了但口令不对」假失败）；Designer 偏好 file/json_key。理由：kuroneko ib-ms07nqqi-d102 `FILES_READY` vs `ALL_CHECKS_PASSED` |
