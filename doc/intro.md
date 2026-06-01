# Amadues · 项目简介

**English summary:** Amadues is a long-running digital-worker stack: outer brain for dialogue and tools, inner brain (Pi-mono) for execution, Chat IR for channels, and optional WebChat / Discord. **WebChat:** start [chat-server](../ops/webchat-deploy.md) first, then [Agent](../deploy/agent-quickstart.md)—see [startup-order.md](../deploy/startup-order.md) (not an OpenClaw-style all-in-one UI).

一个真正能在工程环境中长期工作的 AI 员工系统。

现有工具的核心痛点，我们逐一解决：

- **不再需要 @**：Agent 能主动判断何时参与对话，多个 Agent 在群聊中可以自然协作，不会失控互呛
- **复杂任务不爆上下文**：任务再长再复杂，执行状态始终清晰，不随对话变长而崩坏
- **聊天和工作不再串台**：对话就是对话，任务就是任务，多 Agent 协作时互不干扰
- **执行不阻塞对话**：派发任务后 Agent 立即可以响应新消息，任务完成后主动报告结果，不需要等待
- **知识自动沉淀复用**：每次任务经验自动归档，下次直接复用，越用越聪明，不需要人工维护技能库
- **跨任务情报共享**：多个并行任务共享同一知识池，不再各自为战

> 目标：**一个有持续目标、能自主规划、与人自然协作的数字员工，而不是需要精心喂 prompt 才能动的工具。**
