# Kuroneko (utlra) — 架构概览

本软件系统的 **ADL 权威** 为同目录上一级的 [`workspace.dsl`](../workspace.dsl)。

- **L1**：用户经 IM 说话。外脑把抽象请求拆成可执行任务，派进车间。
- **L2**：`agentServer` 外脑进程 + `innerWorker` 工人子进程 + 共享库（Chat IR、Workspace Kit）。
- **L3**：派活权威是 [`WORKSHOP.md`](../WORKSHOP.md)（2026-10-17）。OKR、KPI、闲时找活、离台再唤醒已从代码和图里去掉。模块表见 [`modules-catalog.md`](../modules-catalog.md)。确定性工作流见 [`EXECUTABLE-WORKFLOW.md`](../EXECUTABLE-WORKFLOW.md)。内脑 Harness-RSI 见 [`HARNESS-RSI.md`](../HARNESS-RSI.md)（**其 P5 自改写已被否定**，推导见 [`HARNESS-RSI-NEGATIVE-RESULTS.md`](../HARNESS-RSI-NEGATIVE-RESULTS.md)，替代设计见 [`TOOL-MDL-GROWTH.md`](../TOOL-MDL-GROWTH.md)，落地证据见 [`TOOL-MDL-GROWTH-RESULTS.md`](../TOOL-MDL-GROWTH-RESULTS.md)）。记忆边界见 [`MEMORY-STORAGE-BOUNDARY.md`](../MEMORY-STORAGE-BOUNDARY.md)。测试对照见 [`COMPONENT-TEST-MAP.md`](../COMPONENT-TEST-MAP.md)。

工具链：[`TOOLCHAIN.md`](../TOOLCHAIN.md)（`validate` / `inspect` / `local` / 代码 diff）。
