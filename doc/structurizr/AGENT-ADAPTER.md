# AgentAdapter（ADL）

> **English:** The admission contract for any teammate. The host calls one function, `accept`. WorkBuddy, DSH, Cursor, and Amadeus implement the same turn. A remote product speaks that turn as one JSON request. The terminal holds a thin adapter so the host still only sees `accept`. This contract is not Chat IR.

> **状态**：2026-10-18。类型与远程 `accept` 在 `packages/agent-host`（`createRemoteAccept`）。终端界面还没做。

> **不做**：把这组字段放进 Chat IR；在适配器里决定群里谁先说话；让适配器读别的队友的聊天记录或工作目录；在适配器里改写内外脑用词。

---

## 1. 进程内的形状

主机和终端只依赖这个接口。类型与 `AgentHost` 放在一起。

```text
AgentAdapter
  profile: { id, name, job, createdAt }   id 由主机分配
  accept(turn) -> { say?, presence?, handoff? }

turn
  message: HostMessage     当前这一条。人发的，或另一名队友传来的
  roster:  { id, name, job }[]    其他已注册队友的公开名单
  peers:   PresenceCard[]  与 roster 同一批人的状态卡

presence?: { doing, waitingOn? }
handoff?:  { toAgentId, note }    交给另一名已注册队友，由主机送出，只一跳
```

`say` 为空表示这一轮不回复。`doing` 是给人看的一句近况。`handoff.toAgentId` 必须是 `roster` 里的 id。

`accept` 看不到群调度，也看不到 JEV。终端已经决定把这一条送给谁，适配器只处理这一条。

---

## 2. 远程产品说同一组字段

WorkBuddy、DSH、Cursor 跑在自己的进程里，不引用终端，也不引用 `packages/agent-host` 的实现。它们实现一次请求：

```text
POST accept
  { message, roster, peers }
→ { say?, presence?, handoff? }
```

字段与上面的 `turn` / 返回值相同。

终端进程里为每一个远程地址放一个薄适配器：它实现 `AgentAdapter.accept`，把这次调用转成上面的请求，再把响应交回主机。主机仍然只看见 `accept`。

创建队友时，终端交出名字、岗位，以及按这个地址组装好的 `accept`。主机不保存 URL，不 spawn 对方进程。

---

## 3. 和主机的分工

| 谁 | 做什么 |
|----|--------|
| 主机 | 保存花名册，调用 `accept`，原样返回 `say`，送出一跳 `handoff` |
| 适配器 | 思考，并填 `say` / `presence` / `handoff` |
| 终端 | 决定这条群消息送给谁（点名，或 JEV），然后 `deliver` |
| Chat IR | 不参与这组字段。某个产品自己的微信或飞书仍走它自己的渠道 |
