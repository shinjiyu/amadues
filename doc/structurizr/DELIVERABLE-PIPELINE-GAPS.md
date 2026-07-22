# 产物管道缺口验证（ADL · 2026-07-22）

> **English:** Production verification + **implementation contract** for two deliverable-pipeline gaps: (A) KPI burst exit skips asset ingest when IM notify is suppressed; (B) DyFlow deliverable path checks produce false negatives.
>
> 互补权威：[`KPI-BURST-OUTCOME-EVALUATOR.md`](./KPI-BURST-OUTCOME-EVALUATOR.md) §1、[`INNER-BRAIN-IM-NOTIFY-BOUNDARY.md`](./INNER-BRAIN-IM-NOTIFY-BOUNDARY.md)、[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §6.7 / §6.7a、[`doc/protocols/inner-brain-deliverables.md`](../protocols/inner-brain-deliverables.md)。

---

## 0. 结论（本轮 ADL 验证）

| ID | 缺口 | ADL 判定 | 实现状态 |
|----|------|----------|----------|
| **A** | KPI `onExit` 把 **产物吸收（ingest）** 绑在 **用户 IM 通知（notify）** 上，KPI 禁 IM → 连 ingest 也跳过 | **确认违约**：协议要求吸收独立于是否 `postMessage` | ✅ 已落地 |
| **B** | `DeliverableCheck.kind=file` / `outputs.type=file` 路径字面匹配过严 + `last_failure` 成功后不清理 → 假阴性「输出契约未满足」 | **确认契约不完备**：须规范路径别名与失败态清零 | ✅ 已落地 |

### 0.1 实现 API 契约（代码必须对齐）

| 导出 | 模块 | 行为 |
|------|------|------|
| `ingestInnerBrainDeliverablesOnExit` | `outer/completion-notify.ts` | 读 COMPLETE / `deliverables.json` → `ingestDeliverables` → `engine.setDeliverables`；**无** `postMessage` |
| `notifyInnerBrainTaskComplete` / `Partial` | 同上 | 可选 `skipIngest`：onExit 已吸收时只发 IM |
| onExit `DONE` / `ERROR`+partial | `index.ts` · `outer-tools.ts` | **先** ingest；再按 `shouldNotifyUserOnBurstExit` 决定是否 IM |
| `checkFile` P-alias | `deliverable-check.ts` | `X` ↔ `workspace/X`（及去/加前缀候选） |
| `commit_local_dag` P-rel | `designer-tools.ts` | 拒收绝对路径 / `..` 的 file·json_key target |
| `recordNodeResult` P-clear | `memory-store.ts` | `ok===true` → `last_failure = null` |
| `gatherEvidence` P-evidence | `node-acceptance.ts` | 收录 `register_deliverable` 路径 + shell 重定向落盘提示 |

**禁止误解**：

- A ≠「KPI 应自动刷屏 IM」。KPI **仍禁止**默认 `completionNotify`（见 outcome 分流）。
- B ≠「验票永远失败」。多数失败仍是真实 `safety_cap` / 缺文件；本缺口解释**路径声明与落盘不一致时的误杀**。

---

## 1. Gap A — ingest 与 notify 耦合

### 1.1 现行 ADL 意图（已写清的部分）

| 文档 | 意图 |
|------|------|
| `KPI-BURST-OUTCOME-EVALUATOR` §1 | KPI：`onExit` **禁止** `completionNotify`；可写 feedback / `burst_finished` |
| `inner-brain-deliverables` §0–§4 | 「物理文件→asset」唯一转换点在外脑 `onExit(DONE)`；`status.deliverables[]` 是 LLM/`read_inner_status`/`send_file` 的唯一可见性来源 |
| `INNER-BRAIN-IM-NOTIFY-BOUNDARY` | 管的是 **IM 三类通知**，未授权「为防刷屏而跳过 asset 吸收」 |

### 1.2 验证到的实现耦合（生产 + 代码对照）

```text
shouldNotifyUserOnBurstExit({ kpiId }) === false   // KPI 有意
  → onExit 不调 notifyInnerBrainTaskComplete
  → ingestDeliverables / setDeliverables 落在 notify 路径内 → KPI 也不跑
```

挂载点：`index.ts` / `outer-tools.ts` 的 `onExit`；闸门：`completion-notify.ts` 的 `shouldNotifyUserOnBurstExit`。

### 1.3 生产证据（Kuroneko `packages/server/data/` · WeChat · KPI `kpi-mrulwvci-2896`）

| 信号 | 观察 |
|------|------|
| 磁盘 | 多 burst 有 `pi-mono/deliverables.json` / 工作区报告（如 ~680KB `tweet_report.md`） |
| `status.deliverables` / `deliverables.log` | KPI burst **几乎无** asset 吸收；对照 ad-hoc（如晒猫图）有 `statusDeliv` + ingest |
| 外脑 / 微信侧 | 读 `deliverables[].asset_id` →「0 交付」→ 空转重派；用户质疑后才改口 |

### 1.4 级联

`kpiBurstOutcomeEvaluator` P0 用 `deliverableCount`（常来自已吸收清单或登记路径计数）。ingest 跳过 → **即使磁盘有登记产物**，`successConfirmed` 仍易判假 → SelfWorkPolicy / 对话环误以为「无产出」。

### 1.5 目标契约（待实现；本轮只定规）

```text
onExit(DONE):
  1. ALWAYS ingest COMPLETE.deliverables → assets → status.deliverables[]
     （KPI 与 ad-hoc 相同；遵守 R4.3–R4.6 容错）
  2. IF shouldNotifyUserOnBurstExit → completionNotify（含附件 parts）
     ELSE → 不 postMessage；外脑可稍后 send_file / attach_asset_ids
  3. KPI 仍写 outcome / momentum / burst_finished；仍禁止 onExit 直接 spawn
```

协议增量见 `inner-brain-deliverables` **R4.7**；分流表修订见 outcome 文档 §1。

---

## 2. Gap B — 交付物路径假阴性

### 2.1 现行 ADL

`DYFLOW-INNER-EXECUTOR` §6.7 / §6.7a：`file` check = `path.join(workDir, target)` 存在且 size>0。未规定：

- `workspace/X` ↔ `X`（根目录）互认
- 绝对路径（`/tmp/...`、错误的 `/data/workspaces/...`）在 Designer `commit` / 验票侧如何拒收或改写
- 节点后来 `ok` 后是否清除 / 降级 `memory.last_failure`

### 2.2 验证到的失败模式（taxonomy · `memory.last_failure` 等）

| 模式 | 机制 | 用户观感 |
|------|------|----------|
| **双轨路径** | check 写 `workspace/report.md`，shell 写在 workDir 根 `report.md`（或相反） | 「明明有文件仍契约未满足」 |
| **绝对路径** | Designer/`checks.target` 带 `/tmp/...` → 越界或拼到 workDir 外 | 稳定 failed |
| **粘性 last_failure** | 后续节点/轮次已成功，旧 `acceptance_failed` 未清 | 读 memory 像「永远失败」 |
| **登记 ≠ 验票** | `register_deliverable` 有路径，但 `interface.outputs` type=file 证据未进 `gatherEvidence` | 完成通知有登记、节点仍 failed |

实现：`deliverable-check.ts`、`node-acceptance.ts`、`base-node-executor.ts`。

### 2.3 目标契约（待实现；本轮只定规）

| 规则 | 说明 |
|------|------|
| **P-alias** | `kind=file` / `outputs.type=file`：若 `target` 与 `workspace/`+basename 或去前缀后的相对路径**任一**在 workDir 存在且 size>0 → 通过 |
| **P-rel** | Designer `commit_local_dag`：**拒收** `checks.target` / file output 声明为绝对路径或含 `..`（与 deliverables 协议 R2.4 对齐） |
| **P-clear** | 节点终态 `ok`（或整图 DONE 且本节点 ok）时：**清除或归档**该节点贡献的 sticky `last_failure`，避免跨轮误读 |
| **P-evidence** | shell 成功写出的相对路径应进入 `gatherEvidence`，与 `register_deliverable` 互补（登记管回传，验票管节点 ok） |

细则写入 `DYFLOW-INNER-EXECUTOR` §6.7a「路径规范」。

---

## 3. 测项（⏳ → 绿后再改状态）

| 模块 | 单测计划 | 覆盖 |
|------|----------|------|
| completionNotify / onExit 钩子 | ⏳ KPI DONE：`ingest` 调用且 **无** `postMessage`；ad-hoc DONE：ingest + notify | Gap A |
| deliverableCheck | ⏳ `workspace/X` ↔ `X` 别名；绝对路径失败信息稳定 | Gap B |
| nodeAcceptance / designer commit | ⏳ 绝对路径拒收；ok 后 last_failure 清理 | Gap B |
| burstProcessReport / outcome（可选） | ⏳ ingest 后 `deliverableCount≥1` 与磁盘登记一致 | 级联 |

地图行：[`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)。

---

## 4. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-22 | 初版：Kuroneko WeChat KPI 过夜跑 + 代码路径对照，确认 Gap A/B；只定契约，不改业务代码 |
| 2026-07-22 | Gap A/B 落地：`ingestInnerBrainDeliverablesOnExit` + onExit 解耦；P-alias/P-rel/P-clear/P-evidence；单测绿 |
|
