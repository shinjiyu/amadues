# Agent Host（ADL 权威）

> **English:** The PC terminal manages agents through a host framework. Roster, groups, user-visible speech, presence, and agent-to-agent delivery are a library. Any process that implements `AgentAdapter` can join. Amadeus outer/inner brain is one adapter, not the host. Group turn-taking is deferred.

> **状态**：P0 定稿（2026-10-15）。实现：`packages/agent-host`。进度见 [`doc/todo/agent-host-progress.md`](../todo/agent-host-progress.md)。群聊「谁先说话」**不在本文**。

> **不做**：群内第一个发言者的必要计算、发言权调度、@ 之外的抢答规则。那一块等真实群聊样本后再开专篇。

---

## 1. 为什么单独成框架

Grok Bot 的产品中心是调用器：人在终端里创建队友、把队友放进群、队友之间能看见彼此的近况并能传话。队友怎么思考，调用器不管。

Amadues 今天把这件事长在某一个 agent 进程里（外脑提示词、内脑注册表、`DATA_ROOT`）。换一个不是这套内外脑的程序，就接不进来。

因此花名册、群、对用户说话、状态卡、A2A 收成 `@utlra/agent-host`。它不 import `@utlra/server`，不出现外脑 / 内脑 / KPI / burst。

---

## 2. 接入条件

一个 agent 要进终端，只须提供 `AgentAdapter`：

| 字段 | 必须 | 含义 |
|------|------|------|
| `profile.id` | 是 | 主机分配的稳定 id |
| `profile.name` | 是 | 给人看的名字 |
| `profile.job` | 是 | 长期岗位，一句话 |
| `accept(turn)` | 是 | 收下一条 `HostMessage`，返回可选的对用户的话、一张状态、一次交给别人 |

`accept` 看到的环境只有：

- 这条消息（人发的，或另一个 agent 传来的）
- `peers`：其它已注册 agent 的 `PresenceCard`（名字不在卡片里；卡片是 agentId、正在做的一句、在等谁）

它看不到别人的聊天记录，看不到别人的工作目录，也不知道对方是不是 Amadeus。

Amadeus 适配器以后把 `accept` 接到现有外脑入站。外脑、内脑、KPI 留在适配器里面。

---

## 3. 主机拥有的对象

### 3.1 Agent

`createAgent({ name, job, accept })` 写入花名册并挂上适配器。终端用这个创建 agent，不要求用户写 env。进程怎么拉起是适配器的事，主机不 spawn。

### 3.2 群

`createGroup({ name, agentIds })` 只记录成员。至少两名已注册 agent。人是终端用户，不写进 `agentIds`。

`recordGroupMessage` 把消息记在群日志里，**不调用任何** `accept`。谁该被叫醒，本文不定义。

### 3.3 状态卡

`PresenceCard`：`agentId`、`doing`（一句）、`waitingOn`、`updatedAt`。`accept` 的返回值可以更新自己的卡。别的 agent 只读这些卡。

### 3.4 A2A

`accept` 可以返回 `handoff: { toAgentId, note }`。主机把 `note` 做成一条新的 `HostMessage`（`from.kind = agent`）交给对方的 `accept`，并附上当时的 `peers`。只转一跳，不连环转发。

这不是群调度。一对一的「交给另一个 agent」可以发生；群里该不该因此开口，仍待专篇。

---

## 4. 对用户说话

用户可见的句子在离开主机前经过 `toUserSpeech`。适配器内部爱怎么称呼自己的运行时都可以，出口不能把这些词交给用户：

`内脑` `外脑` `KPI` `burst` `set_goal` 以及「任务 ID」行。

固定改写：

| 出口原文 | 用户看见 |
|----------|----------|
| 内脑任务等待您的输入 | 需要你补一句 |
| 内脑任务失败 | 这件没做成 |
| 内脑任务部分完成（未完全达成目标） | 做了一部分，还没完成 |
| 内脑任务被阻塞，需要您的输入 | 需要你补一句 |
| 内脑任务已完成 | 做完了 |
| 已派内脑 | 我去做 |

旧模板仍须被 `isHostNotificationEcho` 认成系统通知，避免历史消息被当成用户回复。新模板同样认。

IM 完成 / 等待 / 失败三条出口（`completion-notify`、`awaiting-notify`）调用这个函数。提示词里用 `USER_SPEECH_PROMPT` 告诉模型同一套说法。过滤是保证，提示词是减少改写。

---

## 5. 和现有模块的边

```text
终端（web-chat，以后）
    → AgentHost.createAgent / createGroup / deliver / recordGroupMessage
        → AgentAdapter.accept     任意实现
            Amadeus 适配器 → 现有 OuterBrain（尚未接上）
Chat IR 仍只做传输，不拥有花名册。
```

| 模块 | 路径 | 依赖方向 |
|------|------|----------|
| Agent Host | `packages/agent-host` | 不依赖 server / chat-ir |
| 用户可见出口 | `toUserSpeech` | server 的 IM 通知 import host |
| 群调度 | 无 | 明确延后 |

---

## 6. 实现顺序

| 步 | 内容 | 状态 |
|----|------|------|
| P0 | 本包：花名册、群成员、状态卡、一跳 A2A、`toUserSpeech`；IM 出口接上过滤 | 进行 |
| P1 | 终端 UI：创建 agent、创建群（只建成员，不调度） | 未做 |
| P2 | Amadeus `AgentAdapter`，把入站接到外脑，内外脑名字不出这层 | 未做 |
| 延后 | 群聊第一个参与者该不该算、怎么算 | 不做 |
