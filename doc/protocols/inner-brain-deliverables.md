# 内脑产物回传协议 `inner-brain-deliverables.v1`

> 子协议 of `inner-outer-protocol.md`。规定**内脑产生的物理文件如何回到用户面前**——
> 从 `register_deliverable` 登记，到外脑系统层吸收为 chat IR `asset`，到出站
> 构造 `MessagePart.attachment`，直到 LLM 通过 `attach_asset_ids` 自由引用。
>
> 适用范围：utlraKuroneko / openKuroneko 同源代码栈。
>
> 版本：v1（2026-05-11，与本仓库 R3 设计同步落地）

---

## 0. TL;DR

```
内脑                                 controller                外脑系统层                       LLM
─────                                ──────────                ──────────                       ───
register_deliverable("a.md")  ─▶  deliverables.json
register_deliverable("b.csv") ─▶
                                     │
                                     ▼ 收尾时
                                  写 COMPLETE.deliverables ──▶ onExit(DONE)
                                  并删除 deliverables.json     │
                                                               │ assetStore.save → asset:<uuid>
                                                               │
                                                               ▼
                                                            inner-status.v1.deliverables[]
                                                            （= 唯一可见性来源）
                                                               │
                                                               ▼
                                                            自动通知 postMessage
                                                            （含 attachment parts）
                                                               │
                                                               ▼ 后续对话中
                                                            read_inner_status ─────▶ LLM 看到 asset_id
                                                                                     │
                                                                                     ▼
                                                                            StructuredReply.attach_asset_ids
                                                                            或 send_file 工具
```

**单一权威路径**：

- 「内脑→外脑」唯一通道：`COMPLETE` 事件的 `deliverables: string[]` 字段。
- 「物理文件→asset」唯一转换点：外脑 `onExit(DONE)` 分支。
- 「LLM→出站附件」唯一引用：`attach_asset_ids: string[]`（裸 UUID）。

---

## 1. 名词

| 词 | 定义 | 标识符形态 |
|---|---|---|
| **deliverable** | 内脑 workspace 内**已被显式登记**的物理文件 | workspace 相对路径，如 `workspace/report.md` |
| **asset** | Chat IR 层的不可变二进制资产；存于 `ChatAssetStore` | 裸 UUID（如 `a1b2c3d4-...`），通过 `asset:<uuid>` URI 引用 |
| **attachment** | `MessagePart { type: 'attachment', asset_ref }`；**唯一**合法的出站附件形态 | 见 `chat-ir-identity-design.md` §3 |

**严禁**：把文件名/路径拼进 `text` 字段假装"附件"。LLM 与外脑代码都必须用 attachment part 才算"发出"。

---

## 2. 内脑侧职责

### 2.1 工具：`register_deliverable`

```jsonc
{
  "tool": "register_deliverable",
  "input": { "relative_path": "workspace/report.md" }
}
```

| 规则 | 说明 |
|---|---|
| **R2.1** | 内脑产生**任何**想回传给用户的文件，**必须**调用 `register_deliverable` 登记 |
| **R2.2** | 未登记 = 视为"过程产物"，外脑不会主动暴露给用户（即使文件在磁盘上） |
| **R2.3** | 同一路径多次登记 = 一次（去重保证） |
| **R2.4** | `relative_path` 必须是 workspace 相对路径；禁绝对路径、禁 `..`、禁 workspace 外路径 |
| **R2.5** | 登记表落点 `<tempDir>/deliverables.json`（数组 `string[]`）。这是**纯内部协议**，对外脑不可见，外脑只读 `COMPLETE.deliverables` 字段 |

### 2.2 文件可见性建议

虽然不强制，但**建议**内脑把回传文件放在 workspace 子目录（如 `workspace/`）下，便于人类调试 + 与 `.brain` / `.run` / `.tool-outputs` 区分。

---

## 3. 内 → 外传递（`output` JSONL 事件）

### 3.1 `COMPLETE` 事件 schema

```jsonc
{
  "type": "COMPLETE",
  "message": "本次任务的人类可读总结...",
  "target_user": "idp:peer:u_xxxx",  // 可选
  "ts": "2026-05-11T08:03:22.161Z",   // ISO 8601 with offset
  "deliverables": [                    // ← 本协议核心字段
    "workspace/report.md",
    "workspace/data.csv"
  ]
}
```

| 规则 | 说明 |
|---|---|
| **R3.1** | controller 在任务完成时**必须**把当前登记表序列化进 `COMPLETE.deliverables: string[]` |
| **R3.2** | 字段类型固定为 `string[]`；空时**可以**省略或传 `[]`，两者等价 |
| **R3.3** | 路径**必须**是 workspace 相对路径（与 R2.4 一致） |
| **R3.4** | 写入 `COMPLETE` 后，controller **必须**删除 `<tempDir>/deliverables.json`（防止下次任务复用） |
| **R3.5** | controller 在序列化前**必须**剔除不存在的路径，并在 `message` 末尾追加 `[deliverable missing: <path>]` 注记，避免外脑读到无效路径 |

---

## 4. 外脑系统层"产物吸收"

### 4.1 唯一吸收点

| 规则 | 说明 |
|---|---|
| **R4.1** | 外脑**有且仅有一个**地方负责把 `COMPLETE.deliverables: string[]` 转换为 `asset:<uuid>`——即 `outer-tools.ts:onExit(DONE)` 分支 |
| **R4.2** | `PushLoop.handleComplete` **不重复做转换**；继续按既有约定（"通知委托给 onExit"）只打 log |

### 4.2 转换流程

对 `COMPLETE.deliverables` 中**每条**相对路径：

```ts
const absPath = path.join(workDir, relPath);
const buffer  = fs.readFileSync(absPath);
const mime    = inferMimeByExtAndSniff(absPath, buffer);
const saved   = assetStore.save(buffer, mime, path.basename(relPath));
// saved: AssetMeta { id, mime, name, size, created_at, ext }
```

得到的 `DeliverableAsset` 形态：

```ts
interface DeliverableAsset {
  asset_id:      string;   // 裸 UUID，与 saved.id 相同；URI 时拼 `asset:${asset_id}`
  source_path:   string;   // workspace 相对路径（仅供日志/调试）
  filename:      string;   // 出站建议文件名 = path.basename(source_path)
  mime:          string;
  bytes:         number;
  registered_at: string;   // ISO 8601 with offset
  kind:          'image' | 'video' | 'audio' | 'file';
}
```

### 4.3 容错策略

| 规则 | 说明 |
|---|---|
| **R4.3** | 单文件超过 `UTLRA_DELIVERABLE_MAX_BYTES`（默认 25 MiB）= **跳过该文件**，记 warning，不阻断整批 |
| **R4.4** | `assetStore.save` / 读文件失败 = **跳过该文件**，记 warning，不阻断整批 |
| **R4.5** | 全部失败 = `deliverables[]` 为空数组写入 status，外脑自动通知退化为纯 text 并注明失败 |
| **R4.6** | **禁止**用 `listDeliverables(workDir)` 之类全目录扫描方式生成附件清单。**未登记的文件不发**。该 helper 仅可保留为调试用，不得参与生产路径 |

### 4.4 状态写入与通知顺序

```
1. 吸收所有 deliverables → asset
2. 写 inner-status.v1.deliverables[]（见 §5）
3. 发自动通知 postMessage（见 §6.2）——仅当本 burst 允许用户 IM 完成通知
4. 更新 registry 状态为 DONE
```

顺序很重要：**先写状态，再发通知**。否则若 LLM 通过 PushLoop 提前看到通知开始决策，可能 read_inner_status 还看不到 deliverables。

| 规则 | 说明 |
|---|---|
| **R4.7** | **产物吸收（步骤 1–2）与 IM 完成通知（步骤 3）解耦**。KPI-linked burst **禁止**默认 `completionNotify`（见 Structurizr `KPI-BURST-OUTCOME-EVALUATOR` §1），但 **必须**仍执行步骤 1–2，使 `status.deliverables[]` / `asset_id` 可供 `read_inner_status`、`send_file`、`attach_asset_ids`。**禁止**因 `shouldNotifyUserOnBurstExit===false` 跳过 ingest。验证记录：[`DELIVERABLE-PIPELINE-GAPS.md`](../structurizr/DELIVERABLE-PIPELINE-GAPS.md) Gap A |

---

## 5. inner-status.v1 扩展

`inner-status.v1` schema **新增** `deliverables: DeliverableAsset[]` 字段：

```ts
interface InnerBrainStatus {
  schema:       'inner-status.v1';
  workspaceId:  string;
  phase:        InnerPhase;
  goalSummary:  string;
  tickCount:    number;
  lastAction:   string | null;
  lastError:    string | null;
  updatedAt:    string;
  deliverables: DeliverableAsset[];   // ← 新增，默认 []
}
```

| 规则 | 说明 |
|---|---|
| **R5.1** | `read_inner_status` 工具返回值**必须**包含 `deliverables[]`，即使为空也返回 `[]`（让 LLM 明确"无产物"≠"看不见") |
| **R5.2** | `deliverables[]` **只**累计**本次内脑生命周期**已吸收的资产；内脑收到新 goal 进入 DECOMPOSE 时清空 |
| **R5.3** | `deliverables[]` 是 chat IR 资产视图，**不**是内脑磁盘视图——asset 一旦写入 store，后续即使 workspace 被 `fullResetForRetest` 清空，asset 仍有效 |

---

## 6. 外脑出站附件的"单一权威路径"

### 6.1 唯一合法形态

```ts
// MessagePart
{
  type: 'attachment',
  asset_ref: {
    kind: 'image' | 'video' | 'audio' | 'file',
    uri:  `asset:${asset_id}`,
    mime: string,
    name: string,
  }
}
```

| 规则 | 说明 |
|---|---|
| **R6.1** | 出站附件**仅**通过 `MessagePart.attachment` 表达。**严禁**把文件名/路径拼进 `text` 字段假装附件 |

### 6.2 系统自动通知（onExit DONE 分支）

任务完成时由外脑系统层自动发送，无需 LLM 介入：

```ts
const parts: MessagePart[] = [
  { type: 'text', text: completionText },
  ...deliverableAssets.map((d) => ({
    type: 'attachment' as const,
    asset_ref: { kind: d.kind, uri: `asset:${d.asset_id}`, mime: d.mime, name: d.filename },
  })),
];
await imClient.postMessage(threadId, { sender_sid: agentSid, text: completionText, parts });
```

| 规则 | 说明 |
|---|---|
| **R6.2** | 自动通知**必须**把**所有**成功吸收的 deliverables 作为 attachment parts 发出（保证"事情发生过即被传达"） |
| **R6.2a** | WebChat 渠道：`asset:<uuid>` 须经 `webchat-bridge` 上传至 chat-server `/uploads` 后作为 `attachment_ids` 发出（见 [webchat-wire.md §4](./webchat-wire.md)） |
| **R6.3** | 若 deliverables 全部失败或为空 → 退化为纯 text 通知，并在 text 中注明（"内脑未登记任何回传产物"或"产物吸收失败：..."） |

### 6.4 完成通知正文（`audience=im`）

实现：`buildCompletionReport(..., { audience: 'im' })`（`completion-report.ts`），由 `notifyInnerBrainTaskComplete` 调用。

| 规则 | 说明 |
|---|---|
| **R6.4.1** | IM 通知**必须**结果优先：主章节为 `## 结果`（产物 excerpt > knowledge 尾段 > 执行器末句，三选一，不并列重复） |
| **R6.4.2** | IM 通知**不得**包含：任务目标摘要、里程碑进度、执行评估软失败/nextStrategy、执行器末轮总结（与结果重复时） |
| **R6.4.3** | 有登记产物时附 `## 产出文件`（路径列表，≤8 行）；正文**不**重复粘贴附件全文（R6.1） |
| **R6.4.4** | 仅当 `memory.json` `last_failure`（高置信）非空时附 `## 需注意` |
| **R6.4.5** | 全文上限约 3200 字符；首行 `✅ {pickImSummary}` + 正文 + 附件提示 + `— \`instanceId\`` |
| **R6.4.6** | 外脑 mem9 / 排障上下文用 `audience=verbose`（`outer-memory.ts`），与用户 IM 分离 |

### 6.3 LLM 主动 attach

LLM 通过两种方式 attach asset：

**方式 A：`StructuredReply.attach_asset_ids`**（推荐，简洁）

```jsonc
{
  "text": "这是上次分析的报告，请过目：",
  "attach_asset_ids": ["a1b2c3d4-...", "e5f6g7h8-..."]
}
```

运行时**自动**展开为 attachment parts 追加到 `parts` 末尾。

**方式 B：直接在 `parts` 里写 attachment**（适合需要精确控制顺序/穿插的场景）

```jsonc
{
  "text": "对比图：",
  "parts": [
    { "type": "text", "text": "对比图：" },
    { "type": "attachment", "asset_ref": { "kind": "image", "uri": "asset:...", "mime": "image/png", "name": "before.png" } },
    { "type": "text", "text": "vs." },
    { "type": "attachment", "asset_ref": { "kind": "image", "uri": "asset:...", "mime": "image/png", "name": "after.png" } }
  ]
}
```

### 6.4 attach 校验规则

| 规则 | 说明 |
|---|---|
| **R6.4** | LLM 引用的 asset_id（无论来自 `attach_asset_ids` 还是 `parts[].asset_ref.uri`）**必须**在以下集合中存在：① 当前 `inner-status.v1.deliverables[].asset_id`；② 当前 thread 中**入站**消息曾经携带的 asset_id；③ 当次任务上下文 pack 注入的 asset_id |
| **R6.5** | 未通过校验的 asset_id = **静默剔除该条 attach**，记 warning 到 `<workDir>/.run/deliverables.log`，**不阻断**回复（避免 LLM 一个手抖整条回复挂掉） |
| **R6.6** | `asset_id` **不带** `asset:` 前缀（裸 UUID）。系统在构造 attachment 时拼接 URI。若 LLM 在 `attach_asset_ids` 里误写 `asset:xxx`，运行时自动 strip 前缀后再校验 |

### 6.5 系统自动 + LLM 主动是否会重复？

| 规则 | 说明 |
|---|---|
| **R6.7** | 系统自动通知（R6.2）与 LLM 主动 attach（R6.3）**可以重复发送同一 asset**。asset 在 store 里不可变，多次引用 = 多次发送，**不去重**。由 LLM 自行决策（例如"再发一次报告供新加入的用户查看"） |

### 6.6 工具：`send_file`

**签名变更**（v1 起）：

| 字段 | 旧 | 新 |
|---|---|---|
| 参数名 | `file_paths: string`（逗号分隔的绝对路径） | `asset_ids: string`（逗号分隔的 UUID） |
| 输出 | 列出文件路径的 text | 真正构造 attachment parts 出站 |

```jsonc
{
  "tool": "send_file",
  "input": {
    "thread_id": "tid_xxx",
    "asset_ids": "a1b2c3d4-...,e5f6g7h8-...",
    "caption":   "这是上次的报告"
  }
}
```

| 规则 | 说明 |
|---|---|
| **R6.8** | `send_file` 不再接受文件路径。LLM 必须先从 `read_inner_status` 拿到 `deliverables[].asset_id`，再传入 |
| **R6.9** | `send_file` 内部走 R6.3 方式 B：直接构造 attachment parts 并 postMessage |

---

## 7. 生命周期与清理

| 规则 | 说明 |
|---|---|
| **R7.1** | asset 一旦由 §4 写入 store，**永不**自动删除（与 `ChatAssetStore` 既有规则一致：append-only） |
| **R7.2** | workspace 被 `fullResetForRetest` 清空时 = asset **不**受影响（已"上链"到 chat IR 层） |
| **R7.3** | workspace 被 promote-and-shutdown 时 = asset **不**受影响 |
| **R7.4** | `inner-status.v1.deliverables[]` 在新任务（setGoal → DECOMPOSE）时清空；但 store 里的 asset 仍存活，只是从该 status 视图中下架 |

---

## 8. 错误观测

| 规则 | 说明 |
|---|---|
| **R8.1** | §4.3 / §4.4 / §6.5 任何"跳过/拒绝/退化"事件，**必须**追加写入 `<workDir>/.run/deliverables.log`（人可读 JSONL 或纯文本均可）；**不允许**仅 console 静默 |
| **R8.2** | `deliverables.log` 与 `push-loop.offset` / `directives.jsonl` 同层级，是内脑生命周期内的可观测产物 |

---

## 9. 与既有协议的关系

| 既有概念 | 是否变更 | 说明 |
|---|---|---|
| `run-manifest.v1` 的 `outcomes.deliverables` | **不变** | 那个字段服务"任务完成后晋升到 RepositoryStore"，与本协议（服务本次对话回传）解耦 |
| `MessagePart.attachment` schema | **不变** | 本协议是消费方，直接复用现有 schema |
| `StructuredReplySchema.attach_asset_ids` | **语义收紧** | 字段已存在；本协议补"消费契约"（运行时展开为 parts + R6.4 校验） |
| `ChatAssetStore.save` API | **不变** | 直接复用 `save(buffer, mime, originalName)` → `AssetMeta` |
| `inner-status.v1` | **扩展** | 新增 `deliverables: DeliverableAsset[]` 字段 |
| `PushLoop.handleComplete` | **不变** | 继续只打 log，注释更新指向本协议 |

---

## 10. 实现清单（写代码前的 checklist）

- [ ] `packages/core/src/inner-engine.ts` `InnerBrainStatus` 扩展 `deliverables: DeliverableAsset[]`
- [ ] `packages/core/src/inner-engine.ts` 新增 `DeliverableAsset` 类型
- [ ] `packages/server/src/outer/outer-tools.ts:onExit` DONE 分支：
  - [ ] 从 `readLastOutputEvent(workDir)` 取 `ev.deliverables`（**不再**用 `listDeliverables(workDir)`）
  - [ ] 调 `assetStore.save` 转 asset
  - [ ] 写 inner-status.deliverables[]
  - [ ] 构造 attachment parts 出站
- [ ] `packages/server/src/outer/outer-tools.ts` 删除/降级 `listDeliverables` helper
- [ ] `packages/server/src/outer/outer-tools.ts` `send_file` 工具：
  - [ ] 参数 `file_paths` → `asset_ids`
  - [ ] 实现真附件 postMessage
- [ ] `packages/server/src/outer/outer-tools.ts` `read_inner_status` 返回值带上 `deliverables[]`
- [ ] `packages/server/src/outer/outer-reply-llm.ts` 系统提示词补充 R6.4 / R6.6 约束
- [ ] **新建** `packages/server/src/outer/expand-attach-asset-ids.ts`（或集成进 outer-brain 出站前）：
  - [ ] 把 `StructuredReply.attach_asset_ids` 展开为 attachment parts
  - [ ] 校验 asset_id 来源合法性（R6.4）
  - [ ] 不合法静默剔除 + 记 deliverables.log
- [ ] `packages/server/src/outer/push-loop.ts` 注释更新指向本协议
- [ ] 单元测试：onExit DONE 分支 / attach_asset_ids 展开 / R6.4 校验

---

## 修订记录

| 日期 | 说明 |
|---|---|
| 2026-05-11 | v1 初版（R3 设计落地）：把"内脑产物 → asset → 出站"三段链路写死为"单一权威路径"，删除 `listDeliverables` 全扫，`send_file` 参数 file_paths → asset_ids，`attach_asset_ids` 语义从"占位"收紧为"运行时展开为 parts" |
| 2026-07-22 | **R4.7**：产物吸收与 IM 完成通知解耦（KPI 禁 notify 仍须 ingest）；见 Structurizr [`DELIVERABLE-PIPELINE-GAPS.md`](../structurizr/DELIVERABLE-PIPELINE-GAPS.md) |
