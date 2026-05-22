# WebChat Wire Protocol — REST + WebSocket

> 版本：v0.1（M1）
> 关联：[../requirements-standalone-chat-server.md](../requirements-standalone-chat-server.md)、[../inner-outer-protocol.md](../inner-outer-protocol.md)
> 实现：`apps/chat-server/`、`apps/web-chat/`、`packages/webchat-bridge/`、共享类型 `packages/webchat-protocol/`

## 0. 设计约束

- **无认证**：客户端自报身份。REST 用 header `X-User-Id`；WS 首条消息发 `hello`。
- **JSON over WS**：所有 WS payload 都是 zod 校验的 JSON 对象，`type` 字段做 discriminated union。
- **时间字段**：ISO 8601 with offset（`new Date().toISOString()`）。
- **ID 规则**：
  - 大群：`thread_id = "global"`（可通过 chat-server env `WEBCHAT_GLOBAL_THREAD_ID` 改）。
  - DM：`thread_id = "dm:<userA>:<userB>"`，其中 `userA < userB` 字典序。
  - Message ID：UUID v4（chat-server 生成）；适配器入 Kuroneko 时加 `webchat:` 前缀，与 Discord 桥 `discord:` 同构。

## 1. REST 端点

所有请求必须带 `X-User-Id: <user_id>` header。chat-server 首次见到该 user_id 时自动 upsert（display_name 来自 query `?display_name=` 或 WS hello）。

| Method | Path | 用途 |
|--------|------|------|
| GET | `/me` | 回显当前调用者身份 |
| GET | `/users` | 全部已注册用户列表 |
| GET | `/users/online` | 当前在线用户列表 |
| GET | `/threads` | 当前用户可见线程（大群 + 自己参与的 DM） |
| POST | `/threads/dm` | body: `{ peer_user_id }` → 返回 DM 线程（已存在则返回原线程） |
| GET | `/threads/:id/messages?before=&limit=` | 分页历史（默认 limit=50，最大 200） |
| POST | `/threads/:id/messages` | 发送消息 |
| POST | `/uploads` | multipart/form-data 上传附件 |
| GET | `/uploads/:asset_id` | 下载附件 |

### 1.1 `POST /threads/:id/messages` 请求体

```jsonc
{
  "client_msg_id": "optional UUID for dedup/ack",
  "text": "纯文本快捷路径（与 parts 互斥/合并）",
  "parts": [{ "type": "text", "text": "..." }],
  "reply_to_message_id": "可选",
  "attachment_ids": ["asset_id_1"],
  "mention_user_ids": ["userX"]
}
```

服务端会把 `text` + `mention_user_ids` 展开为结构化 `parts`，把 `attachment_ids` 解析为 attachment parts。最终落库的是结构化 `parts` 数组。

### 1.2 消息对象

```jsonc
{
  "id": "<uuid>",
  "thread_id": "global",
  "sender_user_id": "alice",
  "sent_at": "2026-05-14T08:00:00.000Z",
  "text": "hello @bob",                  // 重建出的纯文本（含 @display）
  "parts": [
    { "type": "text", "text": "hello " },
    { "type": "mention", "user_id": "bob", "display_name": "Bob" }
  ],
  "reply_to_message_id": "<uuid>?",
  "mentions": [{ "user_id": "bob", "display_name": "Bob" }],
  "attachments": [
    { "asset_id": "...", "url": "/uploads/...", "mime": "image/png", "name": "x.png", "size": 1234 }
  ]
}
```

## 2. WebSocket

- 端点：`GET /ws`（HTTP upgrade）。无 query 参数；身份通过 `hello` 事件声明。
- 协议：每条消息是一个 JSON 对象，含 `type` 字段。

### 2.1 client → server

| type | payload | 说明 |
|------|---------|------|
| `hello` | `{ user_id, display_name }` | **首条**；不发就不算上线 |
| `subscribe` | `{ thread_id }` | 加入线程订阅，收 `message.new` 等推送 |
| `since` | `{ thread_id, cursor }` | 重连补拉；cursor=最后一条 message_id 或 null |
| `typing` | `{ thread_id }` | 可选 |

### 2.2 server → client

| type | payload | 说明 |
|------|---------|------|
| `presence.sync` | `{ users: [{ user_id, display_name, online, ... }] }` | 连接成功后下发一次全量 |
| `presence.update` | `{ user_id, online }` | 增量 |
| `message.new` | `{ thread_id, message }` | 新消息（订阅过该 thread 的所有 socket） |
| `message.ack` | `{ client_msg_id, message_id }` | 发送回执（仅发回给原发送者） |
| `typing.relay` | `{ thread_id, user_id }` | 中继 typing |
| `error` | `{ code, message }` | 协议/校验/权限错误 |

### 2.3 状态机

```
[connect TCP] → [client sends hello] → [server: presence.sync + presence.update broadcast] → [normal ops]
                                                                                     ↓
                                                                            [close] → presence.update offline
```

未发 hello 的连接：30 秒后服务端主动关闭。

## 3. 错误码

| code | 含义 |
|------|------|
| `invalid_payload` | JSON 解析或 zod 校验失败 |
| `not_authenticated` | 没有 hello / 没有 X-User-Id |
| `not_a_participant` | 试图访问非自己参与的 DM |
| `thread_not_found` | thread_id 不存在 |
| `message_not_found` | reply_to_message_id 不存在 |
| `rate_limited` | 速率限制（M8 接） |
| `internal` | 服务端异常 |

## 4. 与 Chat IR 的对接（适配器侧）

由 `packages/webchat-bridge` 负责：

| chat-server | Chat IR (`@utlra/chat-ir`) |
|-------------|----------------------------|
| `id` | `message_id = "webchat:" + id` |
| `thread_id` | `thread_id`（恒等；适配器只做格式校验） |
| `sender_user_id` | `IdentityRegistry.upsertHuman(sid: "webchat:user:<user_id>", ...)` → `sender_sid` |
| `parts[type=text]` | `{ type: 'text', text }` |
| `parts[type=mention]` | `{ type: 'mention', target_sid, label }` |
| `parts[type=attachment]` | `{ type: 'attachment', asset_ref: { kind, uri, mime, name } }` |
| `reply_to_message_id` | `MessageRecord.reply_to_message_id`（已支持） |

附件 `uri` 默认是 chat-server 外链 URL；若 env `WEBCHAT_MIRROR_ASSETS=1`，适配器入站时下载并 `assetStore.save(...)` 拿到 `asset:<uuid>` URI。

## 5. 配置（chat-server 端）

| env | 默认 | 说明 |
|-----|------|------|
| `PORT` | 8790 | 监听端口 |
| `CHAT_SERVER_DATA_ROOT` | `./data/chat-server` | 持久化目录 |
| `WEBCHAT_GLOBAL_THREAD_ID` | `global` | 大群线程 ID |
| `WEBCHAT_AGENT_USER_ID` | （未设） | 保留 user_id，只有携带 secret 才能声称（M7 加） |
| `WEBCHAT_AGENT_SECRET` | （未设） | 同上 |
| `CHAT_SERVER_CORS_ORIGIN` | `*` | CORS 白名单 |

## 6. 配置（Kuroneko 适配器端，M7 添加）

| env | 默认 | 说明 |
|-----|------|------|
| `WEBCHAT_API_BASE` | （未设） | REST 根 URL；设置即启用 WebChatChannel |
| `WEBCHAT_WS_URL` | 由 API_BASE 推导 | `ws://...:8790/ws` |
| `WEBCHAT_AGENT_USER_ID` | `agent` | 适配器代表 agent 的 user_id |
| `WEBCHAT_AGENT_DISPLAY_NAME` | `Agent` | 同上 |
| `WEBCHAT_AGENT_SECRET` | （未设） | 与 chat-server 端对齐 |
| `WEBCHAT_GLOBAL_THREAD_ID` | `global` | 与 chat-server 端对齐 |
| `WEBCHAT_MIRROR_ASSETS` | `0` | 1=镜像附件到 ChatAssetStore；0=仅引用外链 |

## 7. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-05-14 | 初稿（M1） |
