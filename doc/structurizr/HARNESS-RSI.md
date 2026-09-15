# 内脑 Harness-RSI（自改 · 升级 · 回退）

> **English:** **Inner-only** harness recursive self-improvement: the DyFlow worker **analyzes its own harness/code**, writes versioned **H′**, **gates**, then **upgrades** the active pointer or **rolls back**. Outer brain does **not** RSI — it only spawns/stops.

> **状态**：2026-09-15 ADL 定稿 · 实现 ⏳  
> **关联**：[`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md) · [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md) · [`INNER-NODE-SKILLS.md`](./INNER-NODE-SKILLS.md) · [`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)（门控范型）· [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) · [`TERMINOLOGY.md`](./TERMINOLOGY.md)

---

## 1. 动机

| 现象 | 根因 |
|------|------|
| `record_skill` / `promote_*` 只写一次 | 缺「比上一版更好」与可回退指针 |
| 外脑 W15 `ew_revision` 靠 SelfWork 再开 explore | 那是**外脑提案修 EW**，不是内脑就地自改 |
| 进程 `POST …/restart` | 恢复 worker，**不**换 harness 版本 |
| 公开 RSI 常像蒙特卡罗种群搜索 | 我们要的是**带门控的局部自修复**，不是抽一堆 H 赌 |

**结论**：RSI **只挂内脑**。能力形状 = **改自己 → 升级 → 回退**（加版本与门控）。

---

## 2. 范围

### 2.1 In（可进 H）

| 表面 | 说明 |
|------|------|
| LocalNode body / `promote_local_node` 产物 | 节点战术代码与绑定 |
| 节点绑定 skills（`skill_md`） | Attributor `record_skill` 写入物 |
| EW hops / `expect` / `failurePolicy` | 确定性步骤；revise 出新 `version` |
| workDir 内与任务绑定的脚本（如 `.run/ew/*`） | 随 EW `assets[]` 或 harness 清单引用 |

### 2.2 Out（禁止 RSI 改）

| 表面 | 说明 |
|------|------|
| Outer heartbeat / SelfWorkPolicy / KPI kind / Calendar | 监督层稳定；**外脑不做 RSI** |
| Designer / Executor / Attributor **拓扑** | Roles 冻结；只改内容不改阶段机 |
| Structurizr ADL、tick 顺序、IM notify 边界 | 人类/仓库权威 |
| 模型权重 / 训练数据 | Model-RSI；本专篇不覆盖 |
| `burstMode=execute` 中途 DESIGN redesign | 违 EW；revise 走离线/ATTRIBUTE 后重启 |

### 2.3 与现有闭环的关系

| 机制 | 谁 | 是不是本专篇 |
|------|-----|--------------|
| ATTRIBUTE `record_skill` / `promote_executable_workflow` | 内脑 | **写 H 的原料**；缺门控与 active 指针 |
| Outer W15 `workflowEvolutionPolicy` | 外脑提案 → explore | **互补**；不替代内脑 upgrade/rollback |
| PSTune `active.json` + gate | 业务 workspace | **范型**：指针 + 回归门 → 泛化到 HarnessSpec |
| `POST /api/inner-brains/:id/restart` | 外脑 | **进程恢复** ≠ harness 升级 |

---

## 3. 权威词

| 词 | 含义 |
|----|------|
| **HarnessSpec（H）** | 一次可寻址的 harness 快照：引用的 LocalNode / skills / EW@version / 脚本清单 + 内容哈希 |
| **active pointer** | workspace 内「当前生效」的 H id（类比 `tuning_profiles/active.json`） |
| **revise** | 分析 run-context / 代码 → 提出 H′（新版本，不覆盖旧版） |
| **gate** | 机械验收：相对 H 的 fixtures / EW expect / 回放；通过才允许 upgrade |
| **upgrade** | active ← H′；随后 **restart under H′** |
| **rollback** | active ← 上一通过门控的 H；拒绝或撤回 H′ |
| **restart-with-H** | 同 charter 再进 DESIGN→RUN（或同 workDir respawn），**加载 active H**；≠ 仅拉起进程 |

非正式同义禁止：把「写了一条 skill」叫 upgrade；把进程 resume 叫 RSI restart。

---

## 4. 闭环

```text
Run under H (active)
  → run-context / deliverables / scripts
  → harnessRevise：诊断 → 写 HarnessSpec H′（新 version，旧 H 保留）
  → harnessGate：fixtures + expect；相对 H 不回归
       ├─ pass → harnessPointer.upgrade(H′) → restart-with-H′
       └─ fail → harnessPointer 保持 H（或显式 rollback）；丢弃/标记 H′ rejected
```

**形态**：局部爬山 + 回归门。**不是**蒙特卡罗种群进化（禁止为 RSI 并行抽 m 个无关 H 赌分）。

**评判**：默认机械门控；LLM pairwise 仅作辅助信号，且 **optimizer prompt 不得含 x_eval / KPI 评分细则**（防 rubric 泄漏）。

---

## 5. 存储（目标）

路径根：当前 burst `workDir`（不进外脑 registry）。

```text
.brain/harness/
  specs/<harnessId>.json     # HarnessSpec 正文（content-addressed id 或单调 version）
  active.json                # { "harnessId": "...", "upgradedAt": "..." }
  history.jsonl              # upgrade/rollback/reject 审计
  fixtures/                  # gate 用的最小回放/expect 夹具（可选 P1）
```

`HarnessSpec` 逻辑字段（实现前可先红测 stub）：

```typescript
interface HarnessSpec {
  id: string;                 // e.g. hash or hs-<ts>
  parentId?: string;          // 由哪一版 revise 而来
  createdAt: string;
  refs: {
    localNodeIds?: string[];
    skillRefs?: { nodeRef: string; skillId: string }[];
    workflowRef?: { id: string; version: string };
    assetPaths?: string[];    // workDir 相对路径
  };
  contentHash: string;
  status: 'draft' | 'gated_ok' | 'gated_fail' | 'active' | 'superseded' | 'rejected';
}
```

跨 agent 共享仍走既有 drive9（skills / nodes / workflows）；**active 指针默认仅本 workspace**。promote 到 drive9 须另过 held-out（P3），见 §8。

---

## 6. 模块（ADL）

| 模块 ID | 职责 | 路径（目标） | 阶段 |
|---------|------|--------------|------|
| **harnessSpecStore** | HarnessSpec CRUD + contentHash | `inner-brain/harness-spec-store.ts` | ✅ P0 |
| **harnessPointer** | `active.json` + history；upgrade / rollback | `inner-brain/harness-pointer.ts` | ✅ P0 |
| **harnessRevise** | 读 run-context → 提案 H′；失败节点 `skillRefs` 优先（不可见评测 rubric） | `inner-brain/harness-revise.ts` | ✅ |
| **harnessGate** | 机械 expect / 回放；相对 parent 不回归 | `inner-brain/harness-gate.ts` | ✅ P1 |
| **harnessRestart** | controller：切 active 后重新进入 DESIGN→RUN（或请求同 charter respawn） | `inner-brain/harness-restart.ts` + `controller.ts` | ✅ P1 |
| **harnessRsiCycle** | ATTRIBUTE 失败后 revise→gate→upgrade | `inner-brain/harness-rsi-cycle.ts` | ✅ P2 |
| **harnessHeldOut** | 同类型 held-out charter 机械门控 | `inner-brain/harness-held-out.ts` | ✅ P3 |
| **harnessAutoHeldOut** | 成功 RUN 后对 active H 自动 held-out（已有 pass 则跳过） | `inner-brain/harness-auto-held-out.ts` | ✅ |
| **harnessDrive9Sync** | promote→drive9 前要求 held-out（仅 active 拥有该 EW 时） | `inner-brain/harness-drive9-sync.ts` | ✅ P3 |
| **harnessW15Dedup** | 内脑已覆盖 EW 时抑制外脑 `ew_revision` | `inner-brain/harness-w15-dedup.ts` | ✅ P3 |

**消费方（已有，须读 active）**：

| 模块 | 变更意图 |
|------|----------|
| **runner** / **baseNodeExecutor** / **nodeSkillLoader** | 执行前按 active H 加载 skill / node 绑定 | ✅ P2 `preferredSkillIdsFromActiveHarness` |
| **workflowRunner** | execute 优先 active 指向的 `workflowRef`（若有） | ✅ P2 `readBurstModeMarker` overlay |
| **dyflowAttributor** | RUN 后可触发 revise 提案；**不得**无 gate 直接 upgrade | ✅ 经 `maybeApplyHarnessRsiCycle`（仅失败 RUN） |

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
| **H2** | 每个 H 不可变；upgrade = 改指针，禁止原地改已 active 的 blob |
| **H3** | upgrade **必须**先 `harnessGate` pass；失败则 active 不变 |
| **H4** | rollback 目标必须是曾 `gated_ok` 或历史 active 的 H |
| **H5** | `burstMode=execute` 下禁止用 DESIGN redesign 冒充 revise；revise 产出新 EW version 或新 H，再 restart |
| **H6** | `harnessRevise` 输入不得包含 KPI judge rubric / 外脑 x_eval 全文 |
| **H7** | 进程 restart API ≠ harness restart；文档与工具名须区分 |
| **H8** | 默认不做种群搜索；单 parent → 单 H′ 局部上升（可多轮，但仍串行门控） |

---

## 8. 阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P0** | `harnessSpecStore` + `harnessPointer`（active/history/upgrade/rollback API）；单测红→绿 | ✅ |
| **P1** | `harnessGate`（复用 EW expect / 最小 fixtures）+ `harnessRevise` stub + `harnessRestart` 接 controller | ✅ |
| **P2** | ATTRIBUTE / 显式工具触发 revise→gate→upgrade；runner 读 active | ✅（失败 RUN 自动；成功跳过） |
| **P3** | held-out 同类型 charter 后再允许 sync drive9；与 W15 提案去重 | ✅ |
| **follow-up** | 成功 RUN → `harnessAutoHeldOut`；revise 拉失败节点 skillRefs | ✅ |

参考实现范型：[`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)（profile active + gate + 热加载）。

---

## 9. 可证伪信号

| 若出现 | 则未达标 |
|--------|----------|
| token/轮次涨、机械 expect 不涨 | 买了更长 trace，不是更好 H |
| 仅产生 H 的那次 burst 好看，同 charter 下一发崩 | 过拟合单轨迹 |
| revise prompt 里出现 KPI 评分细则 | rubric 泄漏 |
| execute 中又 `commit_local_dag` redesign | 破坏 EW，不是 harness RSI |
| SelfWorkPolicy / heartbeat 改 `.brain/harness/active.json` | 外脑越权 |

---

## 10. 测试

| 类型 | 文件 | 覆盖 |
|------|------|------|
| 单元 | `harness-spec-store.test.ts` | put/get/immutable ✅ |
| 单元 | `harness-pointer.test.ts` | upgrade / rollback / history ✅ |
| 单元 | `harness-gate.test.ts` | pass/fail；fail 不改 active ✅ |
| 单元 | `harness-revise.test.ts` | 单 H′；H6 拒 rubric；失败节点 skillRefs ✅ |
| 单元 | `harness-restart.test.ts` | request / consume ✅ |
| 单元 | `harness-rsi-cycle.test.ts` | 失败才 RSI；seed/upgrade/cap ✅ |
| 组件 | `harnessRsi.component.integration.test.ts` | restart-with-H + ATTRIBUTE 全链路 ✅ |
| 单元 | `harness-p3.test.ts` | held-out / drive9 / W15 / auto-held-out ✅ |
| 单元 | `workflow-promote.test.ts`（P3 段） | 无 held-out 跳过 drive9 ✅ |
| 单元 | `workflow-evolution-policy.test.ts`（P3 段） | RSI cover 抑制 ew_revision ✅ |

---

## 11. 修订

| 日期 | 说明 |
|------|------|
| 2026-09-15 | 初稿：内脑-only；改自己 / 升级 / 回退；与 W15、进程 restart、蒙特卡罗进化划界 |
| 2026-09-15 | P3 ✅ held-out→drive9 门控；W15 ew_revision 与内脑 RSI 去重 |
| 2026-09-15 | follow-up ✅ 成功 RUN 自动 held-out；revise 优先失败节点 skillRefs |
