# Agent Host（ADL 权威）

> **English:** The teammate terminal manages agents through a host framework. Roster, groups, presence, and agent-to-agent delivery are a library. WorkBuddy, Cursor, and Amadeus join the same way: implement `AgentAdapter`. The host does not rewrite what an agent says, and it does not know about an inner brain. When a group message names nobody, the terminal's JEV picks the first speaker. See [`AGENT-TERMINAL.md`](./AGENT-TERMINAL.md).

> **状态**：2026-10-17。本篇只定主机。适配器见 [`AGENT-ADAPTER.md`](./AGENT-ADAPTER.md)。Amadeus 的接法见 [`AMADEUS-AGENT-ADAPTER.md`](./AMADEUS-AGENT-ADAPTER.md)。终端见 [`AGENT-TERMINAL.md`](./AGENT-TERMINAL.md)。进度见 [`doc/todo/agent-host-progress.md`](../todo/agent-host-progress.md)。

> **设计顺序**：先主机，再适配器，再把 Amadeus 接进适配器。三篇都先设计，不在本篇里写界面。

> **不做**：主机不改写队友说出来的话。内外脑这些词出不出现，是某一个适配器自己渠道上的事，与本框架无关。主机不判断群里谁该说话。

---

## 1. 为什么单独成框架

产品中心是调用器：人在终端里创建队友、把队友放进群、队友之间能看见彼此的近况并能传话。队友怎么思考，调用器不管。

WorkBuddy、Cursor、Amadeus 都是队友。谁实现了 `AgentAdapter`，谁就能挂上。主机不 import 某一种实现，也不认识内外脑。

---

## 2. 主机认识的唯一入口

主机不定义某种产品的内部。它只在 `createAgent` 时收下一个 `accept`。`accept` 的形状写在 [`AGENT-ADAPTER.md`](./AGENT-ADAPTER.md)。

主机调用 `accept` 时交给它：当前这一条 `HostMessage`，其它队友的公开名单（id、名字、岗位），以及这些队友的状态卡。不交出别人的聊天记录，不交出别人的工作目录。

`deliver` 把 `accept` 返回的 `say` 原样交回终端。现有代码里的 `toUserSpeech` 与此不符，按本篇实现时从 `deliver` 去掉。那一层改写不属于主机。

---

## 3. 主机拥有的对象

### 3.1 Agent

`createAgent({ name, job, accept })` 写入花名册并挂上适配器。终端用这个创建 agent，不要求用户写 env。进程怎么拉起是适配器的事，主机不 spawn。

### 3.2 群

`createGroup({ name, agentIds })` 只记录成员。至少两名已注册 agent。人是终端用户，不写进 `agentIds`。

`recordGroupMessage` 把消息记在群日志里，**不调用任何** `accept`。没点名时由谁先答，是队友终端里的 JEV，不在本库。点了名，终端把话 `deliver` 给被点名的人。

### 3.3 状态卡

`PresenceCard`：`agentId`、`doing`（一句）、`waitingOn`、`updatedAt`。`accept` 的返回值可以更新自己的卡。别的 agent 只读这些卡。

### 3.4 A2A

`accept` 可以返回 `handoff: { toAgentId, note }`。主机把 `note` 做成一条新的 `HostMessage`（`from.kind = agent`）交给对方的 `accept`，并附上当时的 `peers`。只转一跳，不连环转发。

这是队友之间的沟通，是接入之后就有的能力。一对一可以把一张便条交给另一个已注册队友。只转一跳，不连环转发。群里没点名时的第一轮由谁答，仍由终端的 JEV 决定，不靠这次交接来猜。

---

## 4. 主机不改写队友的话

队友说什么，主机就送什么。内外脑这些词要不要出现在某条渠道上，由那个队友自己的适配器处理。主机和队友终端都不做这层改写。

---

## 5. 和现有模块的边

```text
队友终端（独立应用；见 AGENT-TERMINAL.md）
    没点名的群消息 → 终端里的 JEV → 一名队友
    点了名 → 直接送给被点名的人
    → AgentHost.createAgent / createGroup / deliver / recordGroupMessage
        → AgentAdapter.accept
            WorkBuddy / Cursor / Amadeus / 其他实现
```

| 模块 | 路径 | 依赖方向 |
|------|------|----------|
| Agent Host | `packages/agent-host` | 不依赖某一种 agent，不依赖 chat-ir |
| 发言裁决 | 队友终端里的 JEV | 终端调用，不进主机 |
| 队友之间传话 | 主机一跳 handoff | 任何适配器都能交一张便条 |

---

## 6. 实现顺序

| 步 | 内容 | 状态 |
|----|------|------|
| 1 | 本篇：花名册、群、状态卡、原样送达、一跳传话。去掉 `deliver` 里的改写 | 已接上 |
| 2 | [`AGENT-ADAPTER.md`](./AGENT-ADAPTER.md)：进程内接口与远程消息是同一组字段 | 远程 `accept` 已接上 |
| 3 | [`AMADEUS-AGENT-ADAPTER.md`](./AMADEUS-AGENT-ADAPTER.md)：Amadeus 实现这一组消息 | `POST /agent-adapter/accept` 已接上 |
| 4 | [`AGENT-TERMINAL.md`](./AGENT-TERMINAL.md)：界面持有主机；没点名时 JEV 指定第一轮 | 设计，实现未做 |
