# 内脑 IM 通知边界（ADL 权威）

> **English:** Separate **completion**, **awaiting-human**, and **progress** IM channels; deduplicate notifications; stop false `awaitingInboundResolver` wakes from agent-forwarded messages. Complements [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md), [`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md), [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md).

> **动机（2026-06-06 生产事故）**：Shiro global 线程同一阻塞结果连发；Kuroneko/Gin 的 `✅`/`⚠️` 完成转发被误当人类回复 → changeWatcher 重唤醒 → 再 BLOCK。KPI active 长期显示为「阻塞/跟进」而非「等人类」或「已部分推进」。

---

## 1. 三类 IM 通知（禁止混用）

| 类型 | 触发 | 唯一发送点 | 模板前缀 | 去重 |
|------|------|------------|----------|------|
| **COMPLETE** | registry `DONE` + 有完成正文 | `completionNotify`（`onExit`） | `✅` + 结果摘要 | `completion-notified.json` |
| **PARTIAL** | registry `ERROR` + `innerBurstExit` 检出 goal 缺口（如部署 `[BLOCKED]`）且仍有产出 | `completionNotify.notifyInnerBrainTaskPartial`（`onExit`） | `⚠️` 部分完成 + 需协助 | `completion-notified.json` |
| **FAILED** | registry `ERROR`（崩溃/DyFlow 失败，非 partial） | `completionNotify.notifyInnerBrainTaskFailed` | `❌` 短原因 | — |
| **AWAITING_HUMAN** | registry `AWAITING` + `ask_user` pending | `awaitingNotify`（`onExit`） | `⏸` 需您输入 | `im-notify-ledger.json` |
| **PROGRESS** | 可选；长任务中途 | `pushLoop`（`UTLRA_PUSHLOOP_PROGRESS=1`） | `🔄` | ledger |

**禁止**：

- `pushLoop` 发送 **BLOCK**（legacy `.run/pi-mono/output` 里 `type=BLOCK` 只记日志，不 `postMessage`）
- `onExit` 读 output 最后一条 BLOCK 发 IM（legacy；改读 `pendings.json`）
- `completionNotify` 与 `pushLoop` 对同一 `COMPLETE` 双发（既有分工保持）

**与内脑 `BLOCK` 状态**：registry `BLOCKED` / `AWAITING` 表「burst 遇阻或等人」语义，**不等于** IM 通知类型；IM 只用上表三行。

---

## 2. `imNotifyDedup`（共享库）

| 属性 | 值 |
|------|-----|
| **路径** | `packages/server/src/outer/im-notify-dedup.ts` |
| **持久化** | `<workDir>/.run/im-notify-ledger.json` |
| **键** | `{ kind: 'awaiting_human' \| 'complete', fingerprint }` |
| **fingerprint** | `sha256(instanceId + kind + normalizedPromptOrSummary)` 前 16 hex |
| **规则** | 同 workDir 同 fingerprint **24h 内**只发一次 IM |

环境变量：`UTLRA_IM_NOTIFY_DEDUP_TTL_MS`（默认 `86400000`）。

---

## 3. `awaitingNotify`（新增组件）

| 属性 | 值 |
|------|-----|
| **职责** | `onExit` 且 `finalStatus=AWAITING` 时，对**最新** `kind=ask_user` + `status=pending` 发一条 IM |
| **路径** | `packages/server/src/outer/awaiting-notify.ts` |
| **In** | `TaskRecord` + `workDir` + `imClient` |
| **Out** | `postMessage` 或 skip（dedup / 无 pending） |
| **挂载** | `index.ts` `spawnAndAttachWorker.onExit`；`outer-tools.ts` `execSetGoal.onExit` |

正文格式（稳定，便于 dedup）：

```text
⏸ 内脑任务等待您的输入

**任务 ID**：`{instanceId}`
**问题**：{ask_user.spec.prompt}

请在本线程回复；回复后将自动继续执行。
```

---

## 4. `completionNotify` 去重

在 `notifyInnerBrainTaskComplete` 入口：

1. 读/写 `<workDir>/.run/completion-notified.json`（`{ at, instanceId, deliverableCount }`）
2. 若已存在且 `instanceId` 相同 → **skip** `postMessage`（仍允许 `setDeliverables` idempotent）

### 4.1 IM 完成正文来源（`audience=im`）

**禁止**把 `memory.json` 全量 active facts（含 drive9 seed）当作 IM `## 结果` fallback。

按序命中即停：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `pickDeliverableExcerpt` | `.md` / `.json` / `.txt` 产物摘要 |
| 2 | `pi-mono/output` 最后一条 `COMPLETE.message` | DyFlow 官方结论 |
| 3 | `execution-context.json` 末轮 executor 输出 | 短摘要 |
| 4 | 固定句 | 「内脑已完成…详见产出文件」 |

`knowledge` / `fact_records` **仅** `audience=verbose`（外脑记忆、排障）使用；与 `notifyInnerBrainTaskFailed`（❌ 短原因、不 dump facts）一致。

实现：`completion-report.ts` `buildImCompletionReport` + `completion-notify.ts` `buildCompletionMessageFromWorkspace`。

### 4.2 IM 正文加固（2026-06-24，D9：完成转发一堆无关信息）

**事故**：`COMPLETE.message`（= DyFlow `outcome.reason`）本身可能是 `BrainFS.tail(knowledge)` 的**记忆尾巴**（含 `…（省略前文 N 字符，仅展示最近内容）` + seed facts），priority-2 直接信任 → 把工具用法/路径备忘当「## 结果」发进 `webchat:global`；且 `✅` 标题抓到引用块/表格/代码片段成乱码。

边界消费侧（IM 出口）强制两条，**不依赖上游产出干净**：

| # | 规则 | 实现 |
|---|------|------|
| **G1 记忆堆拦截** | `completeMessage` / 末轮 executor 输出若命中 `省略前文…仅展示最近内容` 等记忆尾标记 → **视为不可用**，回退下一优先级（最终落固定句「内脑已完成…详见产出文件」） | `buildImCompletionReport` `isMemoryDump()` |
| **G2 标题净化** | `pickImSummary` 跳过噪声行（`>` 引用 / `\|` 表格 / `` ` `` 代码 / `-`·`*` 列表 / `…`·`（摘自`·`（省略` / 表格分隔线）；**优先取正文首个内容标题**（`#`，但跳过模板小节名「结果/产出文件/需注意/核心结论/关键事实」），否则取首句干净散文 | `pickImSummary()` |

> **上游遗留（follow-up）**：DyFlow `done` 的 `outcome.reason` 不应直接塞 `knowledge` 尾巴；理想在 controller 产出干净结论。当前以 IM 边界 G1/G2 兜底（防御纵深，符合 §4.1「IM 出口不 dump facts」）。

---

## 5. `awaitingInboundResolver` 误匹配防护（修订 §5.2）

在 [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md) 原规则之上增加 **拒绝 resolve**：

| # | 条件 | reason |
|---|------|--------|
| R1 | `senderSid` 在 **agent-mirror 表** | `sender_agent_mirror` |
| R2 | 正文匹配 agent 通知模板 | `agent_notification_echo` |
| R3 | 正文以 `✅` / `❌ 内脑任务失败` / `⚠️ 内脑任务部分完成` / `⚠️ 内脑任务被阻塞` 开头 | `agent_notification_echo` |

**agent-mirror 表**（MVP 硬编码 + 可扩展）：

- `webchat:user:kuroneko` — WebChat 上 Kuroneko 外脑转发账号（非终端人类）
- 未来：`UTLRA_AGENT_MIRROR_SIDS` 逗号分隔

仍要求：`isHumanSender` 为 true 且通过 R1–R3 才进入 instance 匹配。

---

## 6. `changeWatcher`：spawn 前 `markConsumed`（修订 §5.3）

```text
unconsumed = listUnconsumedResolved(brainDir)
if unconsumed.length > 0:
  markConsumed(brainDir, unconsumed.map(p => p.id))   // ★ 新增：spawn 前消费
  spawnTask(task)
```

**目的**：同一 resolved pending 只触发 **一轮** burst；避免每秒 tick 重唤醒（昨晚 Shiro `unconsumed=1` 循环）。

消费时机：**spawn 成功入队后、子进程启动前**（非 worker 内），与 ADL「changeWatcher 统一 spawn」一致。

---

## 7. DyFlow `RUN → AWAITING`（P0 接线）

[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §3 已定义转移；实现缺口补齐：

```text
RUN 结束（local_dag 跑完或 failure distill 后）:
  if listActivePendings(brainDir).length > 0:
    writeState({ mode: 'AWAITING' })
    return { hadWork: false }   // worker idle 退出 → registry AWAITING
  else:
    writeState({ mode: 'DESIGN', ... })
```

**不**在 RUN 内无限 DESIGN↔RUN 空转等人类；有 `ask_user` pending 即挂起。

---

## 8. KPI 语义分层（修订 `suggestKpiAction`）

| 建议动作 | 条件 | 外脑/心跳含义 |
|----------|------|----------------|
| `awaiting_human` | 在途 burst `is_async_waiting` 且存在 `ask_user` pending | **正常等待**；勿重复 set_goal；勿当 stuck |
| `follow_up` | 在途 AWAITING 但无 ask_user / safety_cap 失败循环 | 需外脑介入或换路线 |
| `achieved` | 不变（`post_complete` + deliverables） | 结案 |
| `stuck_retry` | idle streak 达阈值 | outcome 换 charter；**不**通知用户 |

`formatKpiDigest` / 心跳块须展示 `awaiting_human` 与 `follow_up` 不同文案，避免 KPI「看起来像个 BLOCK」。

`shouldAutoAchieveKpi`：**不变**（`isAwaiting` 仍阻止自动 achieved）。

---

## 9. 测试映射

| 模块 | 单元测 | 组件测 |
|------|--------|--------|
| `imNotifyDedup` | `im-notify-dedup.test.ts` | — |
| `awaitingNotify` | `awaiting-notify.test.ts` | ⏳ |
| `awaitingInboundResolver` | 扩展 R1–R3 | 既有 |
| `pushLoop` | BLOCK 不发送 | 扩展 |
| `changeWatcher` | spawn 前 markConsumed | 扩展 |
| `kpi-progress` | `awaiting_human` 分支 | — |
| DyFlow controller | RUN→AWAITING | ⏳ |

---

## 10. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-06-06 | 初版：IM 三类通知、dedup、resolver 防 echo、markConsumed、DyFlow AWAITING、KPI awaiting_human |
| 2026-06-08 | PARTIAL 通知：goal 含部署但 memory/dyflow 有 `[BLOCKED]` → `ERROR` + `⚠️` 部分完成（仍附产出） |
| 2026-06-24 | §4.2 D9：IM 正文加固——G1 记忆堆拦截（`省略前文…` 标记的 `completeMessage`/末轮输出不当结果）+ G2 `pickImSummary` 净化（跳过引用/表格/代码/截断行，优先内容标题） |
