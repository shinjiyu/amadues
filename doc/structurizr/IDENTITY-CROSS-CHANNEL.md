# 跨渠道身份认同与通道注册（ADL 权威）

> **English:** Cross-channel identity is a **`channel_key → internal_sid` map**. The sole everyday source of truth for “same person on two channels” is a **bilateral confirmation handshake** (system state machine—not LLM judgment). Feishu is **N connections per agent**, with **runtime hot-add** via chat + keychain. Complements [`doc/chat-ir-identity-design.md`](../chat-ir-identity-design.md) §11（本文 supersede 其「仅有 bindings 占位、无 merge」的运行时缺口描述）。

**状态**：设计已定稿（2026-07-16）· **实现**：P0 ✅ 映射+双边确认；P0b ✅ 入站 resolve（webchat/discord + OuterBrain canonicalize）；P1 ✅ 外脑工具 + 入站确认口令；P2 ✅ Fan-in + 连接表 + 热插工具；P2b ✅ `feishuBridge`（`@utlra/feishu-bridge`，connector 已注册 `index.ts`）（见 §9）

---

## 1. 问题陈述

| 需求 | 设计回答 |
|------|----------|
| Agent 把多渠道同人认成一个人 | 内部稳定 `internal_sid`；渠道只作映射键 |
| 「同人」事实从哪来 | **双边确认**（或 admin 强制）；**不是**对方自称、不是 Agent「觉得像」 |
| Agent 运行时修正映射 | 可**发起** link / 解释状态；**commit 仅系统服务** |
| 一 Agent 多个飞书身份 | Agent 一条 SID + 多条 feishu binding；**飞书通道非单例** |
| 聊天交付 bot 凭证热连飞书 | `channelConnectionRegistry.add` + keychain；不改 `.env` 重启 |

---

## 2. 核心数据：映射表（认知层）

### 2.1 最小模型

```text
channel_key  →  internal_sid
```

| 概念 | 含义 |
|------|------|
| `channel_key` | 结构化键：`{ channel, native_user_id, scope? }`；`scope` 用于飞书 `app_id` 等，避免跨 app 的 `open_id` 碰撞 |
| `internal_sid` | 渠道无关身份，新人默认 `idp:user:<ulid>`；主助手仍为 `idp:agent:…` |
| `IdentityRecord` | **档案**（display_name / aliases / roles / bindings 视图）；**按 sid 存**，不负责裁决同人 |

**入站路径（强制）**：桥解析出 `channel_key` → `identityBindingIndex.resolve` → 得到 `sender_sid` 再进 `OuterBrain`。禁止桥直接把裸 `discord:user:…` 当永久真相而不经 resolve（过渡期可 resolve 未命中时 upsert 新人并 `bind`）。

### 2.2 与现有 `bindings[]` 的关系

- **权威写入**：映射索引（落盘见 §7）。
- `IdentityRecord.bindings[]`：**派生/双写视图**（便于 mention 反查 native id），不得单独成为「同人」事实源。
- 历史 `discord:user:…` / `webchat:user:…`：P0 可作 `internal_sid` 别名或迁移为 `idp:user:…` + 映射；策略见 §9。

### 2.3 非身份映射

群/会话 id → `thread_id` 仍属各桥的 **thread-mapper**，**不是**本模块。

---

## 3. 同人事实源：双边确认（不走 Agent 裁决）

### 3.1 原则

```text
事实：「channel_key_B 与 channel_key_A 同属 internal_sid S」
来源：IdentityLink 服务见证下的双方同意（pending → confirmed）
     或 admin 强制 link（运维旁路，必审计）
```

| 主张 | 是否采信 |
|------|----------|
| A 发起「我是 B / 请绑定 B」→ 系统通知 B → **B 确认** | ✅ commit |
| B 未确认 / 拒绝 / 超时 | ❌ 映射不变 |
| 新人单方自称「我是已有 sid S」且无对端确认 | ❌ |
| Agent LLM「判断」同人并改表 | ❌ **禁止** |

### 3.2 状态机（`identityLinkService`）

```text
          identity_link_request
                    │
                    ▼
              ┌──────────┐
              │ pending  │  持久化；对端投递确认（DM/卡片/口令）
              └────┬─────┘
         confirm │ │ reject / expire
                 ▼ ▼
            committed    void
         (bind keys→S)
```

| 字段（逻辑） | 说明 |
|--------------|------|
| `pending_id` | 不可伪造 token |
| `initiator_channel_key` / `counterpart_channel_key` | 双方键 |
| `target_sid` | 合并目标（通常取发起方已 resolve 的 sid；冲突策略见下） |
| `expires_at` | 超时作废 |
| `created_by_sid` | 发起人；审计 |

**冲突**：`counterpart_channel_key` 已指向另一 sid → **拒绝 pending** 或要求先 `unbind`（P0：拒绝并说明）。

**投递**：经 `ChatIRChannel` / 多连接路由把确认送到**对端 native 用户**；确认回调校验「操作者 native id == counterpart」。群内代点无效。

### 3.3 Agent 的角色（可选）

| 允许 | 禁止 |
|------|------|
| 工具 `identity_link_request` / `identity_link_status` /（admin）`identity_link_admin_force` | 工具或模型直接 `bind` 跨渠道键到任意 sid |
| 向用户解释 pending / 指引去另一渠道确认 | 把聊天里的「我就是他」当成已绑定 |

单方口述绑定（无对端确认）**不在 P0**；若未来加，必须仍满足「调用者 sid == 目标 sid」且不能抢已占用键。

---

## 4. 运行时 API（模块 In/Out）

### 4.1 `identityBindingIndex`（`@utlra/chat-ir`）

| 操作 | In → Out |
|------|----------|
| `resolve(channel_key)` | → `sid \| null` |
| `bind(channel_key, sid)` | 首次见到 / link commit；键已被他人占用 → error |
| `unbind(channel_key)` | 本人或 admin |
| `listKeys(sid)` | 运维 / 工具只读 |
| `linkMerge(sourceSid, targetSid)` | **仅**由 `identityLinkService` 在 confirmed 后调用：重映射 source 的所有 key → target，档案合并 |

### 4.2 `identityLinkService`（`agentServer`）

| 操作 | In → Out |
|------|----------|
| `requestLink({ initiatorSid, counterpartKey, … })` | → `pending_id`；出站确认消息 |
| `confirm(pending_id, actorChannelKey)` | 校验 actor == counterpart → `linkMerge` |
| `reject` / `expire` | void pending |
| `adminForceLink` | 白名单 SID；审计日志 |

### 4.3 桥的义务

1. 入站：native → `channel_key`（含 feishu `scope=app_id`）→ `resolve` → `sender_sid`。  
2. 出站 mention：`sid` → `listKeys` / bindings 视图取**当前连接**对应 native id。  
3. **不**在桥内实现同人猜测。

---

## 5. 多飞书身份与通道热插（关联约束）

身份认同与飞书接线正交，但 ADL 一并约束，避免桥按「单例」实现。

### 5.1 一 Agent · N 飞书身份

```text
idp:agent:assistant
  bindings / channel_keys:
    feishu + app_A + bot_open_id_A
    feishu + app_B + bot_open_id_B
    webchat + …
```

- **人设 SID 唯一**；多个机器人 = 多条映射/binding，不是多个 agent。  
- 人类在不同 app 的 `open_id` 不同 → `channel_key.scope = app_id`；稳定人键优先 `union_id` / 租户 `user_id` 写入 `native_user_id`（`open_id` 可作出站路由辅键，见飞书桥专篇落地时细化）。

### 5.2 `channelConnectionRegistry`（非单例 · 可热插）

| 字段（逻辑） | 说明 |
|--------------|------|
| `connection_id` | 稳定 id |
| `kind` | `feishu` \| … |
| `app_id` / 等价 | scope |
| `secret_ref` | **keychain** 条目，禁止明文进 `identities.json` / IM 回显 |
| `status` | `connecting` \| `up` \| `down` \| `failed` |
| `bot_open_id` | 探测成功后写入；并 `bind` 到主助手 sid |
| `added_by_sid` / `added_at` | 审计 |

**热插场景**（用户新开飞书 → 聊天把凭证交给 Agent）：

1. 权限闸：仅白名单 / admin SID 可 `feishu_channel_add`。  
2. `app_secret` → `memoryBlockStore` keychain。  
3. `channelConnectionRegistry.add` → 启动该 app 的 Feishu client。  
4. 探测失败 → 回滚，不留半开连接。  
5. 成功 → agent feishu binding + 入站扇入同一 `OuterBrain`。

**装配**：进程入口不再假设「唯一 `ChatIRChannel`」；需 **Fan-in / Composite**（入站合流、出站按 thread→connection 路由）。详见 [`channel-bridge-guide.md`](../channel-bridge-guide.md)（将随实现更新 §6）。

### 5.3 Typing（飞书）

无原生 typing API → reaction `emoji_type: "Typing"` 模拟（见 channel-bridge-guide §5.4）。属桥实现细节，不改身份模型。

---

## 6. ADL 模块与关系

| 模块 ID | 容器 | 职责 |
|---------|------|------|
| **identityBindingIndex** | `chatIrLib` | `channel_key → sid`；resolve/bind/unbind/linkMerge |
| **identityLinkService** | `agentServer` | pending 双边确认；唯一日常写跨渠道映射的入口 |
| **channelConnectionRegistry** | `agentServer` | N 条 IM 连接元数据；运行时 add/remove；凭证只持 `secret_ref` |
| **feishuBridge**（L2，⏳） | 新容器 | 每 connection 一 client；入站 resolve；出站按 app 路由；Typing reaction |

```text
桥 inbound → identityBindingIndex.resolve → OuterBrain
用户/工具 → identityLinkService.request → 渠道投递确认
对端 confirm → identityLinkService → identityBindingIndex.linkMerge
用户交 bot 凭证 → channelConnectionRegistry.add → keychain + feishu client
```

**禁止**：`outerConversationLoop` / 模型输出直接改映射文件；`feishuBridge` 绕过 `resolve` 写死 per-channel sid 且永不经索引（过渡期新建人除外）。

---

## 7. 存储边界

| 数据 | 路径（逻辑） | 谁写 |
|------|----------------|------|
| 映射索引 | `DATA_ROOT/identity/channel-bindings.json`（或等价） | **仅** `identityBindingIndex`（经 link 服务或首次 upsert） |
| 身份档案 | `DATA_ROOT/identities.json`（现有） | `IdentityRegistry`；bindings 与索引双写/派生 |
| pending link | `DATA_ROOT/identity/link-pending/*.json` | `identityLinkService` |
| 通道连接表 | `DATA_ROOT/channels/connections.json` | `channelConnectionRegistry` |
| 飞书 secret | `vault/blocks/keychain/…` | `memoryBlockStore` |

见 [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) 增补行。

---

## 8. 与旧文档对齐

| 文档 | 关系 |
|------|------|
| [`chat-ir-identity-design.md`](../chat-ir-identity-design.md) §11 | 本文为**运行时权威**；§11.3「永不自动合并」改为「仅经 identityLinkService / admin」 |
| [`channel-bridge-guide.md`](../channel-bridge-guide.md) | 多连接 + Fan-in；SID 经 resolve；飞书 scope=app_id |
| 飞书企业禁自建应用 | 热插失败要显式错误；身份模块仍独立可用（WebChat/Discord） |

---

## 9. 落地阶段与测试

| 阶段 | 内容 | 测试（计划） |
|------|------|----------------|
| **P0** | `identityBindingIndex` + `identityLinkService` pending/confirm/reject/adminForce | ✅ `identity-binding-index.test.ts`；✅ `identityLinkService.component.integration.test.ts` |
| **P0b** | 入站强制 resolve（桥 / Facade）；HTTP 经 canonicalize 兜底 | ✅ `resolve-inbound-sender.test.ts`；✅ `inbound-sender-canonicalize.component.test.ts`；webchat/discord inbound 已接线 |
| **P1** | 外脑工具 `identity_link_request` / `identity_link_status`；入站「确认绑定/拒绝绑定 \<pending_id\>」确定性口令（OuterBrain Step 0.52 短路，不走 LLM；对端校验 = pending.counterpart_key ∈ 发送者已绑定 keys） | ✅ `identity-link-tools.test.ts`；✅ `identity-link-inbound.test.ts` |
| **P2** | `FanInChatIRChannel`（chat-ir；入站合流 + thread→connection 出站路由，主渠道为 default）；`ChannelConnectionRegistry`（connections.json + keychain secret_ref + 探测失败回滚 + bootLoad 重连）；工具 `feishu_channel_add/list/remove`（admin 闸 `UTLRA_CHANNEL_ADMIN_SIDS`：条目经 **bindingIndex 折叠比对**——同人从任意已确认渠道入站均放行，白名单限"谁能操作"、不限"接哪些飞书"；`*` = 显式放开） | ✅ `fan-in-channel.test.ts`；✅ `channel-connection-registry.test.ts`；✅ `channel-connection-tools.test.ts` |
| **P2b** | `feishuBridge`（`packages/feishu-bridge`）：每 connection 一个 `FeishuChannel`（事件源可注入，生产 = 飞书长连接 SDK **可选依赖**，未装时热插显式报错回滚）；入站 `channel_key = {feishu, union_id∥open_id, scope=app_id}` 经 resolve；出站 REST text + `<at>`；Typing = 对最后一条人类消息打 `Typing` reaction，idle/回复后撤；`createFeishuConnector` 已注册 `index.ts` connectors map（kind=feishu） | ✅ `api-client.test.ts`、`inbound.test.ts`、`feishu-channel.test.ts`、`connector.test.ts`、`thread-mapper.test.ts`（27 项） |

COMPONENT-TEST-MAP 行状态：⏳ 直至实现转 ✅。

---

## 10. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-16 | 初稿：映射表 + 双边确认事实源 + Agent 不裁决；多飞书非单例与运行时热插；P0–P2 |
| 2026-07-17 | P2b 落地：`@utlra/feishu-bridge`（api-client / inbound / FeishuChannel / connector），connector 注册进 `connectors` map；thread_id 编入 app_id（`feishu:<app_id>:chat:<chat_id>`）保证多连接路由与出站归属 |
| 2026-07-17 | 通道 admin 闸修正：静态字符串比对 → bindingIndex 折叠比对（linkMerge 后 canonical sid / 新渠道同人不再被锁在门外）；新增 `*` 显式放开 |
| 2026-07-16 | P0 落地：`IdentityBindingIndex` + `IdentityLinkService`（可注入、可单测）；入站接线 / 工具仍 ⏳ |
| 2026-07-16 | P0b：`resolveInboundSenderSid`；webchat/discord inbound + `OuterBrain` canonicalize；`DATA_ROOT/identity/channel-bindings.json` |
| 2026-07-16 | P1：外脑工具 `identity_link_request/status`（`identity-link-tools.ts`）；入站确认解析 `identity-link-inbound.ts`（确定性口令，非 LLM）；`index.ts` 装配 `IdentityLinkService`（pendingDir=`DATA_ROOT/identity/link-pending`，admin 白名单 `UTLRA_IDENTITY_ADMIN_SIDS`）。跨渠道确认投递（deliverConfirm 主动私聊对端）留待 P2 与多连接路由一并做 |
| 2026-07-16 | P2（除飞书桥）：`FanInChatIRChannel`（`@utlra/chat-ir/runtime`）；`ChannelConnectionRegistry`（`DATA_ROOT/channels/connections.json`；secret 仅 keychain ref；add 探测失败整体回滚；bootLoad 失败标 down 保留记录）；工具 `feishu_channel_add/list/remove`；`index.ts` 主渠道包进 fan-in 作 default 连接，imClient 全部改指 fan-in。connectors map 目前为空——`feishuBridge` connector 落地后注册即可热插 |
