# Amadeus 接入 AgentAdapter（ADL）

> **English:** Amadeus is one remote teammate. It implements the `accept` JSON from [`AGENT-ADAPTER.md`](./AGENT-ADAPTER.md). A turn from the teammate terminal enters the existing outer-brain conversation and comes back as `say`, `presence`, and an optional `handoff`. WeChat, Feishu, and today's Web Chat stay on their own inbound. The adapter does not import the host's roster logic, and the host does not import the outer brain.

> **状态**：2026-10-18。`POST /agent-adapter/accept` 在 Amadeus 进程里。实现：`packages/server/src/outer/amadeus-agent-adapter.ts`。

> **不做**：把 Amadeus 写成终端里的特殊分支；让 `handleInbound` 继续把这句话发进微信或飞书；让终端读取 `DATA_ROOT` 或派工。

---

## 1. 放在哪

Amadeus 进程提供 `POST /agent-adapter/accept`，请求和响应就是 [`AGENT-ADAPTER.md`](./AGENT-ADAPTER.md) 的那一组字段。

终端把这个地址登记成一个远程适配器。对人来说，这是花名册上的一名队友，名字和岗位在创建时填写。

依赖方向：Amadeus 实现这组消息。`packages/agent-host` 不 import server。server 可以依赖 `@utlra/agent-host` 的类型，用来和这组字段对齐。

建议路径：`packages/server/src/outer/amadeus-agent-adapter.ts`。

---

## 2. 一次 accept

1. 用这条 `HostMessage` 开一轮外脑对话。线程用主机这条消息自己的 id，不并进微信、飞书或现有 Web Chat 的线程。
2. 回复收集 `reply_to_user` 的正文，放进 `say`。这一轮不调用 IM 的 `postMessage`。没有回复则 `say` 为空。
3. `roster` 和 `peers` 写进这一轮的上下文：队友的名字、岗位、正在做的一句。外脑据此决定要不要把一张便条交给别人。
4. 这一轮增加一个只在本适配器里出现的工具 `hand_to_teammate(toAgentId, note)`。调用它就填 `handoff`，不在 Amadeus 里再投递一次。主机负责一跳送达。
5. `presence.doing` 取这名队友当前工作台上的一句话。有人在等用户输入时，`waitingOn` 写成对方的 id；没有则空。

人在微信或飞书里找这同一个 Amadeus 时，仍走今天的 `handleInbound`。那条路径不经过这个 `accept`。

---

## 3. 和车间的关系

终端上的一句话如果是一件可以上手的事，外脑仍用现有派工把一名工人派进车间。适配器不新写一套派工。工人留在台上等人时，下一条从终端来的、属于同一条主机消息线程的回复，送到那张台。

适配器不向终端解释车间、工人或工作台这些内部说法。终端只展示 `say` 和状态卡。
