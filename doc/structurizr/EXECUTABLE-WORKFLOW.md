# 确定性工作流（Executable Workflow）

> **English:** **Executable Workflow** is the frozen, stepwise-checkable contract for *running known playbooks*. It is a **superset** of Skills (markdown SOPs are one kind). Explore mode may invent; **execute mode must not redesign**.

> **状态**：2026-07-23 ADL 定稿 · **P0–P4 ✅**（含 browser/frozen 真跑 · drive9 seed · ATTRIBUTE promote）  
> **关联**：[`INNER-NODE-SKILLS.md`](./INNER-NODE-SKILLS.md) · [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §7b · [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md) · [`BROWSER-SESSION-TOOL.md`](./BROWSER-SESSION-TOOL.md) · [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md) · [`DRIVE9-KNOWLEDGE-SHARED.md`](./DRIVE9-KNOWLEDGE-SHARED.md) · [`TERMINOLOGY.md`](./TERMINOLOGY.md) · [`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md) R7

---

## 1. 动机

| 现象 | 根因 |
|------|------|
| 任务摸索完成后，再跑同一业务反而飘 | DyFlow / baseNode / SelfWork 优化的是**探索**：可 redesign、可换工具、可「再理解目标」 |
| Skills 写了很多仍不稳 | 现有 skill 多是 **prompt 提示**，执行时可选、可改写，不是法令 |
| 数字员工刚需是「按既定流程再跑一遍」 | 缺显式 **execute** 运行时；只能开新一轮探索 burst |

**结论**：要立的是 **Executable Workflow（确定性工作流）** 这一层；Skills 是其中一种载体，不是全集。

---

## 2. 概念分层

```text
                    Executable Workflow（契约超集）
                    ┌─────────────────────────────────────┐
                    │  版本 · 入口 · 逐步验收 · 失败策略     │
                    ├──────────┬──────────┬───────────────┤
                    │ SkillMd  │ Playbook │ FrozenDag …   │  ← 载体（kind）
                    └──────────┴──────────┴───────────────┘
                                      ▲
                                      │ promote（冻结）
                         Explore burst → ATTRIBUTE（自动）/ 聊天显式指定
```

| 权威词 | 含义 | 不是 |
|--------|------|------|
| **Executable Workflow（EW）** | 已冻结、可逐步机械验收、execute 模式下默认禁止 redesign 的契约 | 「又一篇 skill.md 提示」 |
| **WorkflowKind** | 载体类型（见 §3） | 运行时模式 |
| **BurstMode** | `explore` \| `execute`（本发 burst 的自由度） | KPI 本身 |
| **promote（晋升冻结）** | 探索产物 → 带版本的 EW | 仅 `record_fact` / 仅写 skill 正文而不绑执行契约 |
| **Skill（现有）** | EW 的一种 kind（`skill_md`）；另见节点绑定 skills | EW 的同义词 |

与 DyFlow §7b「固化两层」的关系：

| 层 | 载体 | 确定性 | 本专篇 |
|----|------|--------|--------|
| **A 事实** | `fact_records` / drive9 knowledge | 低（提示） | 仍保留；**不**自动等于 EW |
| **B 节点** | LocalNode（仍 LLM ReAct） | 中 | 仍可探索用 |
| **C 工作流（本篇）** | Executable Workflow | **高**（逐步验收 + 禁 redesign） | **新增** |

---

## 3. WorkflowKind（载体）

| kind | 说明 | 现有锚点（复用，不另起炉灶） | 存储（目标） |
|------|------|------------------------------|--------------|
| **`skill_md`** | Markdown 操作步骤（人/Attributor 蒸馏） | `SkillDrive9Store` `/skills/shared/`；`nodeSkillStore` | drive9 + 可选节点绑定 |
| **`browser_playbook`** | 有序 browser steps / playbook JSON | `browserPlaybook` / `browser_run_steps` | EW 正文或引用 workspace 路径 |
| **`frozen_dag`** | 已冻结的 DyFlow `local_dag` + LocalNode 图（禁止 DESIGN redesign） | `local_dag.json` / `localNodeStore` | EW 快照 + content-addressed 版本 |
| **`shell_pipeline`** | 固定 argv 的脚本序列（路径+参数写死） | fact「脚本路径」的升级形态 | EW 正文 steps[] |
| **`kpi_sequence`** | 外脑侧「KPI → 固定子目标/charter 序列」 | SelfWork / advance；step.action=`kpi_charter` | EW steps[] |

**P0 必做 kind**：`skill_md` + `browser_playbook` + `frozen_dag`（其余可后置）。

---

## 4. 契约字段（逻辑 schema）

见实现：`outer/executable-workflow-types.ts`。要点：`version` 晋升必 bump；每步 `expect` 可机检（W3）；`failurePolicy.onStepFail`。

---

## 5. BurstMode：explore vs execute

| | **explore（现状默认）** | **execute（本篇新增）** |
|--|-------------------------|-------------------------|
| 入口 | 模糊 / 窄 charter，自由 DESIGN | **绑定** `workflowId@version` |
| Designer | 可 `commit_local_dag` / redesign | **默认关闭** |
| 失败 | 换路线、再探 | `failurePolicy`；默认同格重试 → escalate |
| 成功 | 走出一条路 | **逐步 expect 全过** |

数字员工：当 KPI 已有 EW（tag `kpi:{id}`）时，SelfWork 优先 `burstMode=execute`。

---

## 6. 生命周期

```text
[explore burst]
  → 产出：facts / LocalNode / skill / playbook / 成功 dag
  → ATTRIBUTE promote_executable_workflow（探索成功后自动）
       或聊天 workflow_promote（用户显式指定 id / workspace / 路径）
       → 校验 steps+expect → DATA_ROOT/workflows/ + 可选 drive9

[execute burst]
  → 加载 EW → workflowRunner 逐步 expect → workflow_run.json

[治理]
  → 连败 → workflowFailureCircuit pause EW（不强制 pause KPI）
```

### 6.1 promote 不变量

| ID | 不变量 |
|----|--------|
| **W1** | promote **必须**产生 `version`；同 id 新内容 = 新 version |
| **W2** | execute **禁止**静默改 EW 正文 |
| **W3** | 每个 step 须机械 `expect`（`exitCode` \| `fileExists` \| `stdoutContains`） |
| **W4** | `skill_md` 晋升后：explore 仍可当提示；execute 以 EW steps 为准 |
| **W5** | `action` **仅**允许 runner 词表：`shell` \| `browser_steps` \| `run_node` \| `assert` \| `skill_step` \| `kpi_charter`（禁止把内脑工具名如 `shell_exec`/`browser_open`/`write_file` 当 action） |
| **W6** | 按 action **必填 args**：`shell`→`command`；`browser_steps`→`steps`\|`playbook`\|`playbookPath`；`run_node`→`dag`\|`dagPath`；`kpi_charter`→`charter`；缺省拒收、不写盘 |
| **W7** | ATTRIBUTE **优先 `from=auto`**（扫 local_dag/playbook 由系统填合法 steps）；自由 `steps_json` 仅补录且仍受 W3/W5/W6 约束 |
| **W8** | **路径可移植**：禁止写死 `…/workspaces/task-…` 或其它 agent workspace 绝对路径；`expect.fileExists` / `playbookPath` / `dagPath` / shell 内路径须相对 **当前 workDir**（execute 的 cwd） |
| **W9** | **步间状态落盘**：每步 shell 是独立进程，禁止依赖上一步的 `$VAR`/`${VAR}`；跨步中间态写 workspace 相对文件（推荐 `.run/ew/`），同一步内赋值再用可以 |
| **W10** | promote **结构预检**（shadow）：校验通过后方可 `put`；已入库违 W8/W9 的契约由 `pauseInvalidWorkflows` 停用 |
| **W11** | **凭据不进契约**：禁止在 steps/args 写入 Cookie/Token/密码明文；须顶层 `secretRefs`（env 名 → keychain entry）；若误写在 `args.secretRefs` **promote 时自动 hoist**；execute 由 runner 注入 |
| **W12** | **KPI→EW 角色**：同 `kpi:{id}` 可挂多 EW；SelfWork 默认优先 `role:primary` → `role:collect` → 无 `role:repair|verify` 的条目；repair/verify 不抢日常 execute |
| **W13** | **辅助脚本随契约**：shell 引用的相对脚本（如 `.run/ew/*.py`）必须打进 `assets[]`（path+content）；promote 有 workDir 时自动收集；execute **先物化 assets 再跑步骤** |
| **W14** | **外脑不阻塞**：EW shell **禁止 spawnSync**；`workflow_run` / `set_goal(execute)` 在 agent 进程内 **后台**跑（立即返回 RUNNING），禁止 await 整段采集堵死对话环 / health |
| **W15** | **Agent 自优化**：execute settle 后 `workflowOutcomeEvaluator` 判质；不合格 → `workflowEvolutionPolicy` **只提案** explore 修订（`purpose=ew_revision`）；成功 explore 后 ATTRIBUTE `promote_executable_workflow` **同 id bump version**。**禁止** SelfWork/execute 静默改 EW 正文；日历硬闸**不阻挡** `ew_revision`（仍挡日常 collect） |

非法契约 **不得**进入 `DATA_ROOT/workflows/`；已入库的空壳/不可移植/明文凭证/缺脚本契约由治理 pause，须重升合法 version。

### 6.2 自优化闭环（W15）

```text
execute settle
  → workflowOutcomeEvaluator（机械 ok + 产物登记/非空）
  → 不合格 → workflowEvolutionStore 记 pending（按 id@version+signature 去重）
  → SelfWork 优先消费 pending → set_goal(explore, purpose=ew_revision)
  → 探索修好脚本/步骤 → promote_executable_workflow(同 id, base_workflow_*)
  → latestVersion 自动被 findWorkflowRefForKpi / 日历 due / **advance_kpi** 命中
```

**派发对齐（2026-07-27）：** 凡 KPI 本地已有匹配 EW（`kpi:{kpiId}` + W12 role），下列入口须 `set_goal(burst_mode=execute, workflow_id, workflow_version)`，**禁止**再默认 explore：

| 入口 | 行为 |
|------|------|
| 日历 due `executePromptAction` | ✅ 已按 `findWorkflowRefForKpi` execute |
| **`advance_kpi` / `kpiAdvancer`** | ✅ 同日历：有 EW → execute；无 EW → explore |
| 聊天显式 `workflow_run` | 始终 execute |

| 模块 | 职责 |
|------|------|
| **workflowOutcomeEvaluator** | 读 `workflow_run.json` + allowlist 产物，产出 `needsEvolution` + reasons |
| **workflowEvolutionStore** | `DATA_ROOT/autonomy/workflow-evolution.json` pending/dispatched |
| **workflowEvolutionPolicy** | settle 记提案；SelfWork 包装器优先提案 explore 修订 |

---

## 7. 模块边界

| 模块 ID | 职责 | 路径 | 阶段 |
|---------|------|------|------|
| **executableWorkflowStore** | EW CRUD | `outer/executable-workflow-store.ts` | ✅ |
| **workflowPromote** | 组装校验写入 | `outer/workflow-promote.ts` | ✅ |
| **promoteExecutableWorkflow** | **ATTRIBUTE 层 C 工具（主晋升）** | `inner-brain/promote-executable-workflow-tool.ts` | ✅ |
| **workflowRunner** | execute 逐步执行（**async shell**） | `inner-brain/workflow-runner.ts` | ✅ |
| **workflowRunBackground** | **✅ 外脑 EW 后台跑（W14）** | `outer/workflow-run-background.ts` | `workflow_run` / `set_goal(execute)` 立即返回 |
| **workflowKindAdapters** | playbook / frozen_dag / kpi_charter | `inner-brain/workflow-adapters.ts` | ✅ |
| **burstModeGate** | explore\|execute 收权 | `outer/burst-mode-gate.ts` | ✅ |
| **workflowTools** | 外脑 list/get/promote/run/pause/suggest | `outer/workflow-tools.ts` | ✅ |
| **workflowDrive9Store** | drive9 `/workflows/shared/` | `drive9/workflow-drive9-store.ts` | ✅ |
| **workflowDrive9Seed** | boot / miss 时 pull → 本地 put | `drive9/workflow-drive9-seed.ts` | ✅ P3 |
| **workflowKindAdapters** | playbook / frozen_dag / kpi_charter | `inner-brain/workflow-adapters.ts` | ✅ P3 真跑可注入 |
| **workflowForKpi** | **✅ KPI tag → EW（W12 role 优先）** | `outer/workflow-for-kpi.ts` | `kpi:{id}` + `role:primary\|collect\|…` |
| **workflowsRoute** | Dashboard 只读 | `api/workflows-route.ts` | ✅ |
| **workflowFailureCircuit** | execute 连败 pause EW | `outer/workflow-failure-circuit.ts` | ✅ |
| **workflowPromoteSuggest** | 外脑只读建议 | `outer/workflow-promote-suggest.ts` | ✅ |
| **workflowOutcomeEvaluator** | **✅ execute 质检（W15）** | `outer/workflow-outcome-evaluator.ts` | ✅ |
| **workflowEvolutionStore** | **✅ 修订提案持久化** | `outer/workflow-evolution-store.ts` | ✅ |
| **workflowEvolutionPolicy** | **✅ settle 记提案 + SelfWork 优先 explore** | `outer/workflow-evolution-policy.ts` | ✅ |

**禁止**：silent 写 EW（无 Attributor/外脑工具调用）；`workspace-kit` 直访 drive9 workflow API。

---

## 8. 与现有模块的接线

| 现有 | 关系 |
|------|------|
| **dyflowAttributor** | **主路径**：`promote_executable_workflow`（与 `record_skill` 同阶段） |
| **Designer `promote_local_node`** | 层 B；层 C 不在 DESIGN 晋升 |
| **digitalEmployeeLoop** | 命中 EW → execute；paused EW 跳过 |
| **kpiFailureCircuit** | KPI 路线 R7 不变；另有 EW 级 circuit |

### 8.1 EW 连败熔断 / 8.2 promote 建议 / 8.3 kpi_sequence

见实现与单测；建议工具不写 registry；`kpi_charter` 物化到 `.run/kpi_sequence/`。

---

## 9. 存储

| 层 | 位置 | 谁写 |
|----|------|------|
| EW 本地 | `DATA_ROOT/workflows/{id}/` | Attributor / `workflow_promote` |
| EW 共享 | drive9 `/workflows/shared/{id}@{ver}.json` | promote 可选 sync |
| EW assets | 同 version JSON 内 `assets[]`（相对 path + utf8 content） | promote 收集；runner 物化 |
| 执行迹 | `<workDir>/.run/workflow_run.json` | workflowRunner |

---

## 10. 工具面

| 工具 | 谁 | 作用 |
|------|-----|------|
| **`promote_executable_workflow`** | **DyFlow ATTRIBUTE** | 探索成功后**自动**晋升（机制主路径） |
| `workflow_promote` | **外脑聊天** | **用户显式指定**晋升/改版/补录（可点名 workspace、路径、steps） |
| `workflow_suggest_promote` | 外脑 | 只读建议（聊天里可先扫再 promote） |
| `workflow_list` / `get` / `run` / `pause` | 外脑 | 查看 / **用户指定** execute / 停用 |
| `set_goal(burst_mode=execute, …)` | 外脑 / SelfWork | 派发确定性 burst（聊天可点名 id@version） |

---

## 11. 分阶段

| 阶段 | 状态 |
|------|------|
| P0 store/gate/runner | ✅ |
| P1 drive9 + SelfWork + Dashboard | ✅ |
| P2 circuit + suggest + kpi_sequence | ✅ |
| ATTRIBUTE 主晋升 | ✅ |
| **P3 真执行 + drive9 下拉** | ✅ async runner；`set_goal`/`workflow_run` 默认注入 browser 真跑（`UTLRA_EW_BROWSER_LIVE=0` 关闭）；boot seed + miss pull |
| **P4 frozen_dag 真跑** | ✅ execute 默认注入 `createDefaultEwFrozenRunLocalDag`（`UTLRA_EW_FROZEN_LIVE=0` 仅物化）；无 LLM 则步骤失败（不假装成功） |

---

## 12. 测试

| 模块 | 单测 |
|------|------|
| store / promote / gate / runner / adapters / tools | ✅ |
| drive9 / for-kpi / circuit / suggest / route | ✅ |
| **promoteExecutableWorkflow（Attributor）** | ✅ `promote-executable-workflow-tool.test.ts` |
| **workflowDrive9Seed** | ✅ `workflow-drive9-seed.test.ts` |
| **workflowAdapters 真跑注入** | ✅ `workflow-adapters.test.ts`（browser inject / frozen runLocalDag） |

---

## 13. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-23 | 初版与 P0–P2 落地 |
| 2026-07-23 | **主晋升改挂 DyFlow ATTRIBUTE `promote_executable_workflow`**；聊天显式指定并列 |
| 2026-07-23 | P3：async `runExecutableWorkflow`；browser 真跑注入；frozen_dag `runLocalDag` 注入；drive9 seed/pull |
| 2026-07-23 | P4：execute 默认 frozen 真跑（`UTLRA_EW_FROZEN_LIVE`）；补 set_goal/designer/circuit 测 |
| 2026-07-24 | **W5–W7**：action 白名单 + args 必填；ATTRIBUTE 优先 auto；拒收空壳晋升 |
| 2026-07-24 | **W8–W10**：路径可移植 + 步间状态落盘 + promote 结构预检；微博粉丝快照场景驱动 |
| 2026-07-24 | **W11–W12**：secretRefs + promote 拒收明文凭证；KPI→EW `role:*` 挑选（X 监控为主验证场景） |
| 2026-07-24 | **W13**：`assets` 打包相对脚本 + `args.secretRefs` hoist；execute 先物化 |
| 2026-07-24 | **W14**：async shell + 外脑 EW 后台执行，禁止堵死事件循环/对话 |
| 2026-07-25 | X 监控 EW@3：4h 窗 + deliverables 登记；日历 settle 走 allowlist ingest + 定时报告附件 |
| 2026-07-25 | **W15**：Agent 自优化闭环（outcome evaluator → evolution proposal → explore → 同 id promote） |
| 2026-07-27 | **派发对齐**：`advance_kpi` / kpiAdvancer 与日历 due 一致——有 `findWorkflowRefForKpi` 命中则 execute，禁止默认 explore |
