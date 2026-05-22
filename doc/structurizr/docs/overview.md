# Kuroneko (utlra) — 架构概览

本软件系统的 **ADL 权威** 为同目录上一级的 [`workspace.dsl`](../workspace.dsl)。

- **L1**：用户仅经 IM（Discord、本地 WebChat）；运维经监控台观察内外脑与 KPI。
- **L2**：`agentServer` 外脑进程 + `innerWorker` 子进程 + 共享库（Chat IR、Workspace Kit）。
- **L3**：外脑模块见 [`modules-catalog.md`](../modules-catalog.md)；KPI 闭环见 [`KPI-CLOSED-LOOP.md`](../KPI-CLOSED-LOOP.md)；记忆边界见 [`MEMORY-STORAGE-BOUNDARY.md`](../MEMORY-STORAGE-BOUNDARY.md)；测试对照见 [`COMPONENT-TEST-MAP.md`](../COMPONENT-TEST-MAP.md)。

工具链：[`TOOLCHAIN.md`](../TOOLCHAIN.md)（`validate` / `inspect` / `local` / 代码 diff）。
