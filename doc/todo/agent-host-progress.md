# Agent Host 进度说明

> 2026-10-15。分支 `feat/agent-subject-p0`，提交 `df14693`。设计权威是 [`AGENT-HOST.md`](../structurizr/AGENT-HOST.md)。

终端要能创建 agent、给 agent 建群。对用户说话时不出现内外脑。agent 能看见别人的近况，并能把一件事交给另一个 agent。这些做成独立框架，任意实现只要满足接入条件就能挂上。群里谁先说话先不做。

## 已落地

| 项 | 位置 | 说明 |
|----|------|------|
| ADL | `doc/structurizr/AGENT-HOST.md` | 主机、接入条件、群只记成员、一跳 A2A、用户用词 |
| 框架包 | `packages/agent-host` | 花名册、建群、状态卡、一跳交接、`toUserSpeech`。不依赖 server，也不依赖 chat-ir |
| 用户可见出口 | `completion-notify`、`awaiting-notify`、两套系统提示 | 完成、失败、等人这三条 IM，以及提示词，走同一套说法 |
| 旧通知仍可识别 | `isHostNotificationEcho` | 历史里的「内脑任务…」和新说法都不当成用户回复 |

接入条件就四样：稳定 id、名字、一句岗位、一个 `accept`。`accept` 只看到当前这条消息和别人的状态卡。

## 还没做

| 项 | 原因 |
|----|------|
| 群聊调度 | 先要分析真实群聊里第一个参与者该不该算、怎么算。主机收到群消息只记日志，不叫醒 agent |
| 终端界面 | 还不能在 PC 上创建 agent 或建群 |
| Amadeus 适配器 | 外脑入站还没有包成 `AgentAdapter`。内外脑仍在 server 里面 |
| 并进 `main` | 这条分支还停在功能分支上。仓库首页的标是另一笔提交，在 `main` |

## 没进这次提交的本地改动

微信线程回退、`goal-max-ticks`、本地启动脚本，以及 `data-aki` / `data-kuroneko` 运行数据，都还在工作区里。运行数据不要提交。
