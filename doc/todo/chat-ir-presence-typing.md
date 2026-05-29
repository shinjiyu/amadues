# Chat IR 用户状态协议（presence / typing「正在输入中」）

> **状态：typing 已完成（2026-05-29）**；presence agent 在线态仍待补。
> 从 [`doc/todo/README.md`](./README.md) 链入。

## ✅ 已实现（typing 全链路，自底向上）

| 层 | 改动 |
|----|------|
| `packages/webchat-protocol` | `ClientTyping` / `TypingRelay` 加 `state: 'start'\|'stop'`（relay 默认 start）+ relay 带 `display_name`；新增 REST `TypingRequestSchema` |
| `apps/chat-server` | `WsHub.relayTyping(threadId, userId, state)` 公开方法（ws `typing` 与 REST 共用，带 display_name 扇出，排除发起者）；新增 REST `POST /threads/:id/typing` |
| `packages/chat-ir` | `ChatIRChannel` 加**可选** `sendActivity(threadId, kind: 'typing'\|'idle')`（跨渠道活动信号出口，瞬时不落库） |
| `packages/webchat-bridge` | `WebChatRestClient.sendTyping(threadId, state)`；`WebChatChannel.sendActivity` 映射 typing→start / idle→stop，best-effort |
| `packages/server`（外脑） | `outer-brain.ts` 用 `withTypingActivity()` 包裹回复生成：开始发 `typing`、按 `UTLRA_OUTER_TYPING_REEMIT_MS`(默认 4s) 周期重发、`finally` 发 `idle` |
| `apps/web-chat` | `ws.ts.sendTyping`；`App.tsx` 消费 `typing.relay`（按线程聚合 + 8s 兜底超时 + 收到对方消息即清除）；`MessageTimeline` 渲染「X 正在输入…」三点动画；`MessageInput` 输入时节流上报（4s 重发 start / 停顿 3s 或失焦/发送/卸载发 stop） |

设计要点：typing 为**瞬时信号**，不写 `MessageRecord`、不进 mem9；显式 stop + 双端兜底超时；agent 长生成靠周期重发保活。Discord 渠道 `sendActivity` 暂未实现（接口可选，后续可映射 `POST /channels/:id/typing`）。

## ⏳ 仍待补（presence 在线态）

- agent 启动/退出广播在线态（agent 走 REST，`me()` 会上线，但缺少显式离线广播）。
- 可作为独立小批接入，复用 presence.update。

---

## （以下为原始设计草案，保留备查）

## 背景与动机

希望实现「正在输入中」这类**用户/agent 状态变更**的实时指示，提升对话在场感（尤其是 agent
回复前先显示「Shiro 正在输入…」，避免用户以为没人理）。

排查结论（2026-05-29）：

- **chat IR 核心协议（`packages/chat-ir`）没有任何状态概念**。`ChatIRChannel` 被刻意收窄为纯传输
  （`start` / `destroy` / `postMessage` + `onAgentMessage`），`MessageRecord` 也无状态字段。
- **WebChat WS 传输层有一部分，但不完整且未上升到 IR**：
  - `typing`（client→server，`{ type, thread_id }`）
  - `typing.relay`（server→订阅者，`{ type, thread_id, user_id }`）
  - `presence.sync` / `presence.update`（online/offline，**不是**输入中）
  - 见 `packages/webchat-protocol/src/events.ts`、`apps/chat-server/src/ws-hub.ts`（`onTyping`）。

## 现状缺口

1. **只有「开始输入」无「停止输入」**：`typing` 单次触发，靠前端 timeout 自行消退，协议无 stop/idle 语义。
2. **前端尚未消费**：`apps/web-chat` 中 grep `typing` 无结果 → UI 大概率还没渲染输入指示器。
3. **agent bridge 丢弃 typing**：`packages/webchat-bridge/src/webchat-channel.ts` 只处理
   `message.new` / `presence.sync` / `presence.update` / `error`，**不处理 `typing.relay`** → agent 收不到。
4. **agent 无法发起 typing**：`typing` 仅 client→server；agent 走 REST + bridge，没有发 ws `typing` 的通路。
5. **presence ≠ 输入中**：presence 只有在线/离线（`online: boolean`）。

## 最小落地方案（草案，自底向上）

1. **`packages/webchat-protocol`**：给 `typing.relay` 增加 stop 语义（如 `state: 'start' | 'stop'`），
   并允许 agent 链路触发 typing。
2. **`apps/chat-server`（ws-hub）**：加 agent 可调入口（REST `POST /threads/:id/typing` 或允许 agent socket
   发 `typing`），把 agent 的 typing 也 fanout 给订阅者。
3. **chat IR 层（关键）**：在 `ChatIRChannel` 增加活动信号方法，如
   `sendActivity(threadId, kind: 'typing' | 'idle')`，给外脑一个**跨渠道**出口（Discord 渠道可映射其 typing API）；
   入站侧考虑用一个独立 callback（如 `onActivity`）而非塞进 `onAgentMessage`，保持「传输」职责清晰。
4. **`apps/web-chat` 前端**：消费 `typing.relay` 渲染输入指示器（带超时或显式 stop）。
5. **外脑接入**：在 `runOuterRoundtrip` / 心跳派发回复前后调用 `sendActivity('typing')` / `sendActivity('idle')`。

## 决策点（实现前需定）

- typing 是否要进 IR 抽象（跨渠道统一），还是仅做 WebChat 专属增强？建议进 IR，但**不落库**
  （瞬时信号，不写 `MessageRecord`，不进 mem9）。
- stop 语义用显式 `stop` 事件还是纯前端超时？建议「显式 stop + 前端兜底超时」双保险。
- presence 是否一并补齐 agent 在线态（agent 启动/退出广播）？可作为同一批的子项。

## 相关代码锚点

| 关注点 | 路径 |
|--------|------|
| IR 传输接口 | `packages/chat-ir/src/channel.ts` |
| WebChat WS 事件 schema | `packages/webchat-protocol/src/events.ts` |
| chat-server typing 转发 | `apps/chat-server/src/ws-hub.ts`（`onTyping` / `fanoutThread`） |
| agent 侧 bridge（丢弃 typing） | `packages/webchat-bridge/src/webchat-channel.ts` |
| 协议文档 | `doc/protocols/webchat-wire.md` |
