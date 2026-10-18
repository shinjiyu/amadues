# 队友终端（ADL 权威）

> **English:** An independent application and a new chat form. The person creates teammates and puts them in groups. Any agent that implements `AgentAdapter` can join — WorkBuddy, DSH, Cursor, Amadeus. Teammates can hand a note to each other. When a group message names nobody, a JEV inside this app picks who answers first. This app does not rewrite another product's wording, and it does not speak Chat IR.

> **状态**：2026-10-17。实现未做。路径预定 `apps/agent-terminal`。主机见 [`AGENT-HOST.md`](./AGENT-HOST.md)，适配器见 [`AGENT-ADAPTER.md`](./AGENT-ADAPTER.md)，Amadeus 的接法见 [`AMADEUS-AGENT-ADAPTER.md`](./AMADEUS-AGENT-ADAPTER.md)。

> **不做**：把本应用做成现有 Web Chat 的一个页面；让本应用认识某一种 agent 的内部结构；替某个队友去连微信或飞书；改写队友说出来的话。

---

## 1. 这是一种新的聊天

人打开的是一个独立应用。聊天对象是花名册上的队友，以及由这些队友组成的群。

人在这里做四件事：

| 动作 | 主机调用 | 人随后看见 |
|------|----------|------------|
| 创建队友 | `createAgent({ name, job, accept })` | 花名册上多一个名字和一句岗位 |
| 对一个队友说话 | `deliver`，`to.kind = agent` | 该队友的回复，可以没有 |
| 把至少两名队友建成群 | `createGroup` | 群只记成员。人不是成员 |
| 在群里说一句，没有点名 | 终端里的 JEV 指定一名队友，再 `deliver` 给这一名 | 第一轮由这名队友答 |
| 在群里点名 | `deliver` 给被点名的人 | 不经过 JEV |

近况来自状态卡：谁正在做一句什么、在等谁。卡片上没有名字；名字在花名册上。

这和现有 IM 不是同一条对话。现有 Web Chat、飞书、微信仍是某一个队友自己的渠道。那些线程不出现在队友终端里，也不写成主机上的群。

---

## 1.1 没点名时谁先答

群里一句没有点名的话，由本应用里的一个 JEV 裁决。成语接龙就是这种：人没 @ 任何人，只说进行成语接龙。JEV 看到这句话和在册队友（名字、岗位、正在做的一句），指定第一轮由谁答。终端再把这句话送给这一名队友。

点了名就送给被点名的人，不叫 JEV。

JEV 是本应用的发言裁决，不是某一种队友的内部判断，也不是主机库的一部分。队友之间另有传话：答的人可以经主机把下一张便条交给另一个队友。那是一跳交接，不代替 JEV 对一句新的、没点名的群消息做裁决。

---

## 2. 应用只认识主机

本进程持有一个 `AgentHost` 实例。界面上的每个动作都经过 **Host Gateway**，由它调用 `@utlra/agent-host`。花名册、群日志、状态卡、一跳交接都在这个实例里。

| 层 | 谁 | 本应用怎样对待它 |
|----|----|------------------|
| 队友终端 | 本应用 | 新聊天的界面，以及没点名时的 JEV |
| Agent Host | `@utlra/agent-host` | 花名册、群日志、状态卡、队友之间的一跳传话 |
| AgentAdapter | 注册进来的 `accept` | 队友怎么思考。WorkBuddy、DSH、Cursor、Amadeus 都是这一种 |
| 某个队友自己的渠道 | 微信、飞书、现有 Web Chat | 本应用不调用，也不改写那里说出去的话 |

创建队友时，本应用交出名字、岗位，以及组装根已经准备好的 `accept`。本应用不 spawn 进程，不写 env，不读 `DATA_ROOT`。适配器怎么把进程拉起来，是适配器的事。

对用户展示的句子就是队友经 `accept` 返回的那句。本应用不因为某一种实现内部有内外脑，就改写这句话。

一跳交接由主机在 `deliver` 里面完成。本应用把同一次 `deliver` 返回的每段话按队友展示。

---

## 3. 应用内的模块

| 模块 | 一事 | In → Out |
|------|------|----------|
| **hostGateway** | 唯一调用 Agent Host 的地方 | 界面动作 → `createAgent` / `createGroup` / `deliver` / `recordGroupMessage` / `listAgents` / `listGroups` / `listPresence` |
| **rosterTalk** | 花名册，以及对一个队友说话 | 名字 + 岗位 → 新队友；一句给某队友的话 → 该队友的回复 |
| **groupRoom** | 建群，并处理群里的一句 | 没点名 → JEV 指定第一轮谁答，再送达；点了名 → 直接送达 |
| **speakerJudge** | 本应用里的 JEV | 群消息 + 在册队友 → 第一轮答题的那一名 |
| **presenceBoard** | 展示状态卡 | `listPresence` → 谁在做一句什么、在等谁 |

这些模块在实现时落成 `apps/agent-terminal` 的组件。DSL 里队友终端、Agent Host 和 JEV 是 L1 软件系统，内部先写在本文。

---

## 4. 和渠道的边

```text
人 — 队友终端（本应用）
      没点名的群消息 → 本应用里的 JEV → 一名队友
      点了名 → 被点名的队友
      → Agent Host → AgentAdapter.accept
          WorkBuddy / DSH / Cursor / Amadeus / …

人 — 微信 / 飞书 / 现有 Web Chat
      → 该队友自己的渠道
```

上面这条是本应用。下面这条留在那个队友自己的产品里，不改道进入队友终端。

---

## 5. 实现顺序

| 步 | 内容 | 状态 |
|----|------|------|
| 1 | 主机 [`AGENT-HOST.md`](./AGENT-HOST.md) | 设计已定；库有一版，送达时的改写要去掉 |
| 2 | 适配器 [`AGENT-ADAPTER.md`](./AGENT-ADAPTER.md) | 设计已定，实现未做 |
| 3 | Amadeus 接入 [`AMADEUS-AGENT-ADAPTER.md`](./AMADEUS-AGENT-ADAPTER.md) | 设计已定，实现未做 |
| 4 | 本应用：花名册、对一个队友说话、建群、JEV 指定第一轮 | 设计已定，实现未做 |
