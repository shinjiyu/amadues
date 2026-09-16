# 内脑 Harness-RSI（自改 · 升级 · 回退）

> **English:** **Inner-only** harness recursive self-improvement: the DyFlow worker **periodically analyzes** run logs/traces for suboptimal harness, writes versioned **H′**, **gates**, then **upgrades** the active pointer or **rolls back**. Hard failure is an **auxiliary** trigger, not the primary one. Outer brain does **not** RSI — it only spawns/stops.

> **状态**：2026-09-16 ADL 修订（**P5 Loop-Source**：revise 改 loop 全量代码）· P4 实现 ✅ · P5 设计 ⏳  
> **关联**：[`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md) · [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md) · [`INNER-NODE-SKILLS.md`](./INNER-NODE-SKILLS.md) · [`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)（**analyze → gate → active** 范型）· [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) · [`COLLATZ-LEAN-RSI.md`](./COLLATZ-LEAN-RSI.md) · [`TERMINOLOGY.md`](./TERMINOLOGY.md)

---

## 1. 动机

| 现象 | 根因 |
|------|------|
| `record_skill` / `promote_*` 只写一次 | 缺「比上一版更好」与可回退指针 |
| **能跑完但步骤丑、重试多、selector 脆** | 缺**周期复盘**；仅失败才修会漏掉 soft 浪费 |
| 外脑 W15 `ew_revision` 靠 SelfWork 再开 explore | 那是**外脑提案修 EW**，不是内脑就地自改 |
| 进程 `POST …/restart` | 恢复 worker，**不**换 harness 版本 |
| 公开 RSI 常像蒙特卡罗种群搜索 | 我们要的是**带门控的局部上升**，不是抽一堆 H 赌 |

**结论**：RSI **只挂内脑**。能力形状 = **周期分析 → 改自己 → 升级 → 回退**（加版本与门控）。失败触发是辅线。

---

## 2. 范围

### 2.1 In（可进 H）— **以 loop source tree 为第一公民**

| 表面 | 说明 |
|------|------|
| **loop source tree（P5）** | workDir 下 **不可变快照树**：本 burst 内脑 loop 的**全量可执行源码**（见 §5 / §12）。revise 的主产物是对该树的 **patches**，不是 skill 日记 |
| LocalNode body / `promote_local_node` 产物 | 进 tree（或由 tree 内路径引用）；随 H′ 版本化 |
| 节点绑定 skills（`skill_md`） | **辅料**：可进 tree / `skillRefs`；**单独涨 skillRefs 不算有效进化**（H12） |
| EW hops / `expect` / `failurePolicy` | 进 tree 或 `workflowRef`；revise 可改正文并 bump version |
| workDir 任务脚本（如 `run-loop.ts` / `.run/ew/*`） | 列入 `loopRoots` 后可被 patches 改写 |

**「全量」含义**：凡列入该 H 的 `loopRoots` + `manifest` 的文件，RSI **均可**增删改；下一轮 RUN **必须**从 active tree 加载（H10）。不是「只能改 skill 指针」。

### 2.2 Out（禁止 RSI 改）

| 表面 | 说明 |
|------|------|
| Outer heartbeat / SelfWorkPolicy / KPI kind / Calendar | 监督层稳定；**外脑不做 RSI** |
| Designer / Executor / Attributor **拓扑**（阶段机形状） | Roles 冻结；可改各阶段**内容/实现**（tree 内），**不**增删 DESIGN/RUN/ATTRIBUTE 阶段本身 |
| Structurizr ADL、外脑 tick 顺序、IM notify 边界 | 人类/仓库权威 |
| 仓库 `packages/**` **原地**写回 | RSI 只改 workDir **tree 副本**；回写 monorepo 须人类 / 另管线 promote（本专篇不做自动 git commit） |
| 模型权重 / 训练数据 | Model-RSI；本专篇不覆盖 |
| `burstMode=execute` 中途 DESIGN redesign | 违 EW；revise 走 ATTRIBUTE 后 / 离线复盘再 restart |
| `loopRoots` 外路径 / `..` 逃逸 | H11 |

### 2.3 与现有闭环的关系

| 机制 | 谁 | 是不是本专篇 |
|------|-----|--------------|
| ATTRIBUTE `record_skill` / `promote_executable_workflow` | 内脑 | **写 H 的原料**；缺门控与 active 指针 |
| Outer W15 `workflowEvolutionPolicy` | 外脑提案 → explore | **互补**；不替代内脑 upgrade/rollback |
| PSTune `analyze` → gate → `active.json` | 业务 workspace | **主范型**：有轨迹就分析，不要求本轮挂掉 |
| `POST /api/inner-brains/:id/restart` | 外脑 | **进程恢复** ≠ harness 升级 |

---

## 3. 权威词

| 词 | 含义 |
|----|------|
| **HarnessSpec（H）** | 一次可寻址的 harness 快照：`loopTreeId` + LocalNode / skills / EW@version / 清单 + 内容哈希 |
| **loop source tree** | `.brain/harness/trees/<treeId>/`：本 loop **全量源码**的不可变快照；H 通过 `refs.loopTreeId` 引用 |
| **loopRoots** | 相对 workDir（或 tree 根）的允许改写目录/文件前缀；patches 不得逃逸 |
| **loopEntry** | tree 内入口（如 `loop/run.ts`）；restart-with-H 后执行面从此加载 |
| **active pointer** | workspace 内「当前生效」的 H id（类比 `tuning_profiles/active.json`） |
| **analyze** | 读 run-context / 日志 / 近期轨迹 → **soft findings**（不合理优化点）；**不**直接改 active |
| **revise** | 据 findings / run-context / **当前 tree 源码** → 提出 H′（**主产物 = patches → 新 tree**；skillRefs 可选合并） |
| **gate** | 机械验收：fixtures / EW expect / **对 H′ tree 跑 `gate.checks[]`**；通过才允许 upgrade |
| **upgrade** | active ← H′；随后 **restart under H′**（加载新 tree；若已有 active） |
| **rollback** | active ← 上一通过门控的 H（连同其 `loopTreeId`）；拒绝或撤回 H′ |
| **restart-with-H** | 同 charter 再进 DESIGN→RUN（或同 workDir respawn），**加载 active H 的 loopTree**；≠ 仅拉起进程 |
| **cadence** | 每 N 次 ATTRIBUTE 完成触发一次 analyze（默认 N=3；可配置） |

非正式同义禁止：把「写了一条 skill / 只涨 skillRefs」叫有效 upgrade（H12）；把进程 resume 叫 RSI restart；把「本轮失败」当成 RSI 的唯一入口；把「改了 Exploration 工艺文件但 loop 脚本不变」当成 harness 进化。

---

## 4. 闭环

### 4.1 主路径 — 周期复盘（类 pstune analyze）

```text
每 N 次 ATTRIBUTE（成功或失败均可累计）
  → harnessAnalyze：run-context / 日志 /（可选）tree diff 信号 → findings[]
       ├─ 无 actionable findings → 跳过（不空转 revise）
       └─ 有 findings
            → harnessRevise（diagnosis=findings，读 active loopTree，H6）
                 → patches[]（限 loopRoots）→ 物化 tree′ → H′{ loopTreeId, … }
                 → 若无 tree diff 且无 refs 实质变更 → 拒绝提案（H12）
            → harnessGate（fixtures + tree checks）
                 ├─ pass → upgrade → restart-with-H′（执行面加载 tree′）
                 └─ fail → active 不变；H′ = gated_fail / rejected；保留 tree′ 供审计
```

### 4.2 辅路径 — 硬失败

```text
ATTRIBUTE 且 runOk=false
  → 立即允许进入同一 revise→gate→upgrade 环（不受「未到 N」阻塞）
  → 仍受每 burst RSI 轮次封顶（默认 2）
```

### 4.3 形态与评判

**形态**：局部爬山 + 回归门。**不是**蒙特卡罗种群进化（禁止为 RSI 并行抽 m 个无关 H 赌分）。

**评判**：默认机械门控；LLM pairwise 仅作辅助信号，且 **optimizer / analyze prompt 不得含 x_eval / KPI 评分细则**（防 rubric 泄漏）。

**soft findings 例（非穷尽）**：同节点多次重试、步骤冗余、缺绑定 skill、脆路径 / 空 expect 近失、token 或 tool 轮次异常膨胀（相对上一 H 的同 charter 轨迹）、**loop 源码缺陷**（重复逻辑、错误 fallback、未读 active tree、双写 marker 等可点名到 path）。

---

## 5. 存储（目标）

路径根：当前 burst `workDir`（不进外脑 registry）。

```text
.brain/harness/
  specs/<harnessId>.json     # HarnessSpec 正文
  trees/<treeId>/            # loop source tree（不可变快照；含 manifest.json）
  active.json                # { "harnessId": "...", "upgradedAt": "..." }
  history.jsonl              # upgrade/rollback/reject 审计
  fixtures/                  # gate 用的最小回放/expect 夹具（可选）
  analyze-cadence.json       # { attributeCount, interval, lastAnalyzeAt? }
  analyze/<ts>.json          # 可选：最近一次 findings 落盘（审计）
```

`HarnessSpec` 逻辑字段：

```typescript
interface HarnessSpec {
  id: string;
  parentId?: string;
  createdAt: string;
  refs: {
    /** P5：本 H 绑定的 loop 源码快照 */
    loopTreeId?: string;
    /** 允许 patches 触及的相对路径前缀（相对 tree 根） */
    loopRoots?: string[];
    /** tree 内入口文件（restart / runner 加载） */
    loopEntry?: string;
    /** 对 tree′ 的机械检查（shell / tsc / vitest / lake …） */
    gateChecks?: Array<{ id: string; command: string; cwd?: string }>;
    localNodeIds?: string[];
    skillRefs?: { nodeRef: string; skillId: string }[];
    workflowRef?: { id: string; version: string };
    assetPaths?: string[];
  };
  contentHash: string;
  status: 'draft' | 'gated_ok' | 'gated_fail' | 'active' | 'superseded' | 'rejected';
}

/** revise 主产物（写入新 tree，不写进已有 tree） */
interface HarnessPatch {
  path: string;                 // 相对 loop tree 根；须落在 loopRoots 内
  action: 'write' | 'delete';
  content?: string;             // write 时必填
}
```

`trees/<treeId>/manifest.json`：`{ treeId, parentTreeId?, files: Record<path, contentHash>, createdAt }`。  
`contentHash(H)` 必须纳入 `loopTreeId`（及 manifest 根哈希），使「只改 skillRefs」与「改了源码」可区分。

**种子（seed）**：首次可把 allowlist 文件 **复制**进 tree（任务脚本，和/或仓库 `packages/server/src/openkuroneko/inner-brain/*` 的**切片**）。之后 RSI **只改 tree**，不原地改 `packages/`。

跨 agent 共享仍走既有 drive9；promote 到 drive9 须 held-out（P3），见 §8。

---

## 6. 模块（ADL）

| 模块 ID | 职责 | 路径（目标） | 阶段 |
|---------|------|--------------|------|
| **harnessSpecStore** | HarnessSpec CRUD + contentHash | `inner-brain/harness-spec-store.ts` | ✅ P0 |
| **harnessLoopTree** | tree 物化 / 读 manifest / 应用 patches（COW） | `inner-brain/harness-loop-tree.ts` | ✅ P5 |
| **harnessPointer** | `active.json` + history；upgrade / rollback | `inner-brain/harness-pointer.ts` | ✅ P0 |
| **harnessAnalyze** | 读轨迹 → soft findings；管 cadence | `inner-brain/harness-analyze.ts` | ✅ P4 |
| **harnessRevise** | findings + **当前 tree** → patches → H′（H6；H11；H12） | `inner-brain/harness-revise.ts` | ✅ P5 |
| **harnessGate** | fixtures + **`gateChecks` 对 tree′**；相对 parent 不回归 | `inner-brain/harness-gate.ts` | ✅ P5 |
| **harnessRestart** | controller：切 active 后重新进入 DESIGN→RUN | `inner-brain/harness-restart.ts` + `controller.ts` | ✅ P1 |
| **harnessRsiCycle** | 按触发策略调用 analyze→revise→gate→upgrade | `inner-brain/harness-rsi-cycle.ts` | ✅ P4（P5 透传 tree） |
| **harnessHeldOut** | 同类型 held-out charter 机械门控 | `inner-brain/harness-held-out.ts` | ✅ P3 |
| **harnessAutoHeldOut** | 成功 RUN 后对 active H 自动 held-out（已有 pass 则跳过） | `inner-brain/harness-auto-held-out.ts` | ✅ |
| **harnessDrive9Sync** | promote→drive9 前要求 held-out | `inner-brain/harness-drive9-sync.ts` | ✅ P3 |
| **harnessW15Dedup** | 内脑已覆盖 EW 时抑制外脑 `ew_revision` | `inner-brain/harness-w15-dedup.ts` | ✅ P3 |

**消费方（已有，须读 active）**：

| 模块 | 变更意图 |
|------|----------|
| **runner** / **baseNodeExecutor** / **nodeSkillLoader** | 执行前按 active H 加载 skill / node；**P5：优先从 `loopTree` 解析实现** | ⏳ P5 |
| **workflowRunner** | execute 优先 active 指向的 `workflowRef` / tree 内 EW | ⏳ P5 |
| **dyflowAttributor** / **controllerFsm** | 每次 ATTRIBUTE 后走 `maybeApplyHarnessRsiCycle`（**周期为主**；失败辅） | ✅ P4 |
| **最小 loop / Collatz assault** | 入口改为读 active `loopEntry`；revise 可改 loop 脚本本身 | ⏳ P5 |

**外脑**：

| 模块 | 角色 |
|------|------|
| **innerSpawner** | 仅 spawn；可选透传「沿用 workDir active H」 |
| **workflowEvolutionPolicy** | 继续只提案 explore；**不**写 `.brain/harness/active.json` |

---

## 7. 不变量

| ID | 不变量 |
|----|--------|
| **H1** | RSI **仅内脑**；外脑模块不得 revise/upgrade/rollback HarnessSpec |
| **H2** | 每个 H **与每个 loopTree** 不可变；upgrade = 改指针，禁止原地改已 active 的 blob/tree |
| **H3** | upgrade **必须**先 `harnessGate` pass；失败则 active 不变 |
| **H4** | rollback 目标必须是曾 `gated_ok` 或历史 active 的 H |
| **H5** | `burstMode=execute` 下禁止用 DESIGN redesign 冒充 revise；revise 产出新 EW version 或新 H（含新 tree），再 restart |
| **H6** | `harnessRevise` / `harnessAnalyze` 输入不得包含 KPI judge rubric / 外脑 x_eval 全文 |
| **H7** | 进程 restart API ≠ harness restart；文档与工具名须区分 |
| **H8** | 默认不做种群搜索；单 parent → 单 H′ 局部上升（可多轮，但仍串行门控） |
| **H9** | **触发**：主路径 = cadence 到期的 analyze；辅路径 = hard fail。**禁止**把「仅失败才 RSI」写成产品语义；成功轮次仍累计 cadence，到期则复盘 |
| **H10** | 执行面（runner / 最小 loop / baseNode 实现解析）**必须**加载 active H 的 `loopTree`（若 H 声明了 `loopTreeId`）；禁止 upgrade 后仍只跑仓库未快照路径 |
| **H11** | patches 的 `path` 归一化后必须落在 `loopRoots` 内；拒绝 `..`、绝对路径、出树写入 |
| **H12** | **无 loopTree diff（且无 workflowRef/localNode 等实质 refs 变更）不得 upgrade**。仅追加 skillRefs / 日记 skill **不**构成有效 H′ |

---

## 8. 阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P0** | `harnessSpecStore` + `harnessPointer` | ✅ |
| **P1** | `harnessGate` + `harnessRevise` stub + `harnessRestart` | ✅ |
| **P2** | revise→gate→upgrade 接线；runner 读 active | ✅（曾误定为「仅失败」；见 P4） |
| **P3** | held-out → drive9；W15 去重 | ✅ |
| **follow-up** | 成功 RUN → auto held-out；revise skillRefs | ✅ |
| **P4** | **`harnessAnalyze` + cadence**；RSI 主触发改周期复盘；失败仍可立即进环 | ✅ |
| **P5** | **Loop-Source RSI**：`harnessLoopTree` + revise **patches 全量 loop 代码** + gateChecks + H10–H12；消费方从 active tree 加载 | ✅（Collatz E 验证；DyFlow runner 深接入可续） |

参考实现范型：[`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)（`pstune analyze` → gate → active）。  
Collatz 试点对齐：[`COLLATZ-LEAN-RSI.md`](./COLLATZ-LEAN-RSI.md) §6 **E**（revise 改 `assault-loop` / 门控脚本，而非只写 Exploration）。

---

## 9. 可证伪信号

| 若出现 | 则未达标 |
|--------|----------|
| 只在 fail 时才出现 analyze/revise 日志，成功 N 轮从无复盘 | 仍是故障自修，不是周期 RSI |
| token/轮次涨、机械 expect 不涨 | 买了更长 trace，不是更好 H |
| 仅产生 H 的那次 burst 好看，同 charter 下一发崩 | 过拟合单轨迹 |
| analyze/revise prompt 里出现 KPI 评分细则 | rubric 泄漏 |
| execute 中又 `commit_local_dag` redesign | 破坏 EW，不是 harness RSI |
| SelfWorkPolicy / heartbeat 改 `.brain/harness/active.json` | 外脑越权 |
| cadence 到期但 findings 为空仍强制 upgrade | 空转爬山 |
| upgrade 后 `loopTreeId` 不变，仅 `skillRefs` 变长 | **P4 空转**；违 H12 |
| upgrade 后下一轮仍执行 packages 原文件 / 非 tree 入口 | 违 H10；进化未生效 |
| patches 写出 `loopRoots` 外或改了 `packages/**` 原地 | 违 H11 / §2.2 |

---

## 10. 测试

| 类型 | 文件 | 覆盖 |
|------|------|------|
| 单元 | `harness-spec-store.test.ts` | put/get/immutable ✅ |
| 单元 | `harness-pointer.test.ts` | upgrade / rollback / history ✅ |
| 单元 | `harness-gate.test.ts` | pass/fail；fail 不改 active ✅ |
| 单元 | `harness-revise.test.ts` | 单 H′；H6；skillRefs ✅ |
| 单元 | `harness-restart.test.ts` | request / consume ✅ |
| 单元 | `harness-analyze.test.ts` | findings；cadence；H6 ✅ |
| 单元 | `harness-rsi-cycle.test.ts` | 周期触发；失败辅线；无 findings 跳过；cap ✅ |
| 组件 | `harnessRsi.component.integration.test.ts` | restart-with-H + ATTRIBUTE 辅线 ✅ |
| 单元 | `harness-p3.test.ts` | held-out / drive9 / W15 / auto-held-out ✅ |
| 单元 | `workflow-promote.test.ts`（P3 段） | 无 held-out 跳过 drive9 ✅ |
| 单元 | `workflow-evolution-policy.test.ts`（P3 段） | RSI cover 抑制 ew_revision ✅ |
| 单元 | `harness-loop-tree.test.ts` | seed / patch / COW / H11 ⏳ P5 |
| 单元 | `harness-revise.test.ts`（P5 段） | patches→新 tree；无 diff 拒绝（H12）⏳ |
| 单元 | `harness-gate.test.ts`（P5 段） | gateChecks 跑 tree′ ⏳ |
| 组件 | `harnessLoopSource.component.integration.test.ts` | upgrade 后执行面读新 tree ⏳ P5 |

---

## 11. 修订

| 日期 | 说明 |
|------|------|
| 2026-09-15 | 初稿：内脑-only；改自己 / 升级 / 回退；与 W15、进程 restart、蒙特卡罗进化划界 |
| 2026-09-15 | P3 ✅ held-out→drive9 门控；W15 ew_revision 与内脑 RSI 去重 |
| 2026-09-15 | follow-up ✅ 成功 RUN 自动 held-out；revise 优先失败节点 skillRefs |
| 2026-09-15 | **P4 ADL+实现**：主触发改为周期 analyze（范型 pstune）；失败为辅；`harnessAnalyze` + H9 |
| 2026-09-15 | 试点开搞：[`COLLATZ-LEAN-RSI.md`](./COLLATZ-LEAN-RSI.md) Collatz + Lean 最小 loop |
| 2026-09-16 | Collatz C 冲击暴露：仅 skillRefs 账本 **无行为增益** → 驱动 **P5 Loop-Source** |
| 2026-09-16 | **P5 ADL**：loop source tree；revise=patches 全量代码；H10–H12；禁止 skillRefs-only upgrade |

---

## 12. P5 细规 — Loop-Source RSI（代码面自改）

### 12.1 要解决的证伪

Collatz 正式冲击中：H 连续 upgrade，但 `localNodeIds` / `assetPaths` 不变，只涨 `assault-round-*-exploration` 日记 skill；最小 loop **不读**这些 skill → **harness 无真实进化**。  
结论：**skillRefs 合并不足以承载「改自己」**；必须把 **loop 源码**纳入 H 并门控。

### 12.2 闭环（相对 §4 的增量）

1. **seedTree**：按 `loopRoots` 从 workDir（及可选 repo allowlist 切片）拷入 `trees/<id>/`，写 manifest。  
2. **analyze**：findings 可指向具体文件/符号（如「`mergeAppend` 双 marker」「gate 不跑 tsc」）。  
3. **revise**：LLM 或确定性修补器产出 `HarnessPatch[]` → `applyPatches(parentTree) → tree′` → `put(H′)`。  
4. **gate**：对 `trees/<tree′>/` 执行 `refs.gateChecks[]`（失败 = gated_fail）。  
5. **upgrade + restart**：active→H′；入口 `loopEntry` 从 tree′ 解析（动态 import / 子进程 `tsx <tree>/…`）。

### 12.3 全量范围（推荐分层）

| 层 | 内容 | 何时进 loopRoots |
|----|------|------------------|
| **L0 任务 loop** | 如 `assault-loop.ts`、`run-loop.ts`、Lean 工程内脚本 | 最小试点必选 |
| **L1 工作流/节点** | LocalNode body、EW JSON、`.run/ew/*` | 真 DyFlow burst 必选 |
| **L2 内脑引擎切片** | 从 `packages/.../inner-brain/` **vendor** 进 tree 的 runner/harness/controller 等 | 要「修引擎实现」时；仍禁写回 packages |

L2 不是改阶段机拓扑（仍禁增删 DESIGN/RUN/ATTRIBUTE），而是改**已 vendor 的实现文件**。

### 12.4 与「修 monorepo」的划界

| 允许 | 禁止 |
|------|------|
| 改 workDir `.brain/harness/trees/**` | RSI 直接 `write` `packages/server/**` |
| 人类审阅后把 tree diff promote 进仓库 | 自动 `git commit` / 无门控写回 |
| gate 在 tree 内跑 vitest 子集 | 以「猜想为真」当 gate |

### 12.5 实现顺序（仍 Structurizr-first）

| 步 | 内容 | 状态 |
|----|------|------|
| P5.0 | 本专篇 + catalog + COMPONENT-TEST-MAP | ✅ |
| P5.1 | `harnessLoopTree` + 单测（COW / H11） | ✅ |
| P5.2 | `harnessRevise` patches + H12；`harnessGate` gateChecks | ✅ |
| P5.3 | runner / Collatz 入口读 `loopEntry`（H10） | ✅（Collatz `resolveActiveLoopEntry`；DyFlow runner 全量读 tree 仍可扩） |
| P5.4 | Collatz §6 E：冲击改 loop-meta，journal 证 tree diff | ✅ |
