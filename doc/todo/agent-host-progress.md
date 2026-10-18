# Agent Host 进度说明

> 2026-10-17。分支 `feat/agent-subject-p0`。设计顺序：[`AGENT-HOST.md`](../structurizr/AGENT-HOST.md) → [`AGENT-ADAPTER.md`](../structurizr/AGENT-ADAPTER.md) → [`AMADEUS-AGENT-ADAPTER.md`](../structurizr/AMADEUS-AGENT-ADAPTER.md) → [`AGENT-TERMINAL.md`](../structurizr/AGENT-TERMINAL.md)。

接口放在 Agent Host，不放进 Chat IR。终端进程持有主机。远程队友用同一组 `accept` JSON。

## 已落地

| 项 | 位置 | 说明 |
|----|------|------|
| 主机 | `packages/agent-host` | 花名册、建群、状态卡、一跳交接。`deliver` 原样送达，并把其他队友的名单交给 `accept` |
| 远程适配器 | `createRemoteAccept` | 把一次 `accept` 转成 `POST { message, roster, peers }` |
| Amadeus | `POST /agent-adapter/accept` | 外脑对话的回复进 `say`。`hand_to_teammate` 只在这一轮出现。不发进微信或飞书 |

## 还没做

| 项 | 说明 |
|----|------|
| 终端界面 | 没点名的群消息由 JEV 指定第一轮 |
| 并进 `main` | 这条分支还停在功能分支上 |
