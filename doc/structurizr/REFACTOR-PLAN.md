# Kuroneko 架构重构计划（Structurizr 为权威 ADL）

> **原则**：`workspace.dsl` = 设计意图；代码 = 实现；CI = 国境。  
> **节奏**：先模型、后守门、再动刀（蚂蚁搬家，不大爆炸）。

## 阶段总览

| 阶段 | 目标 | 产出 | 代码是否大改 |
|------|------|------|----------------|
| **P0** | 工具链就绪 | `local.bat` / `validate` / `inspect` / `export` | 否 |
| **P1** | **模块模型落盘**（当前） | `modules-catalog.md` + DSL L2 库 + L3 组件 + 视界属性 | 否 |
| **P2** | 国境守门 | `dependency-cruiser` 规则 ← DSL 允许的 `import` 边 | 配置 only ✅ |
| **P3** | 结构对齐 | 按模块拆包 / 禁跨界 import / 收敛 `packages/server` | 是，分批 |
| **P4** | 可选 L3 深化 | 各容器内组件图、动态视角 | 视需要 |

**人类 O(1) 认知**：任意时刻只盯 **一张视图**（L1 / L2 路径 / L3 单容器）+ **一个模块的视界四元组**（见 `modules-catalog.md`）。

---

## P1 检查清单

- [x] L1/L2 容器与集成边（http/ws/spawn/file/import）
- [x] L2 共享库：`chat-ir`、`core`、`webchat-protocol`
- [x] L3 细粒度模块（见 [`GRANULARITY.md`](./GRANULARITY.md)）
  - [x] **participationPolicy**（是否说话）独立模块
  - [x] 内脑 **decomposer / executor / attributor / reflexionModule** 独立模块
  - [x] 视图 `07`/`08`/`09` 分域展示
- [x] 视界元数据 `horizon.*` + [`modules-catalog.md`](./modules-catalog.md)
- [x] `!docs` / `!adrs`（`docs/overview.md`、`decisions/`）
- [x] `npm run structurizr:check` 进 GitHub Actions（`.github/workflows/ci.yml`）

---

## P2 守门（当前）

规则文件：[`deps.rules.cjs`](./deps.rules.cjs)（与 `workspace.dsl` L2 `import` 边对齐）。

| 源 | 允许 import 目标 |
|----|------------------|
| `discord-bridge` | `chat-ir` |
| `webchat-bridge` | `chat-ir`, `webchat-protocol` |
| `chat-server`（产码） | `webchat-protocol` |
| `web-chat` | `webchat-protocol` |
| `agentServer/outer` | `chat-ir`, `workspace-kit`（**禁止** `discord-bridge` / `webchat-bridge`） |
| `agentServer/index` | 可装配 `discord-bridge` / `webchat-bridge`（进程内 Channel） |
| `innerWorker`（openkuroneko + pi-mono） | 无桥、无 chat-ir；禁止 npm import workspace-kit（P3b ✅） |

```bat
cd /d d:\kuroneko
npm run structurizr:deps
REM 或 doc\structurizr\deps-check.bat
```

- [x] `deps.rules.cjs` + `npm run structurizr:deps`
- [x] CI：`structurizr` job（Java 21 + 自动下载 war）

---

## P3 代码重构方向（与 DSL 对齐）

| 子项 | 状态 | 说明 |
|------|------|------|
| **P3a** | ✅ | `@utlra/core` 内联为 `packages/server/src/workspace-kit/`，删除独立包 |
| **P3b** | ✅ | `brain-snapshot` 去 workspace-kit import；`setGoal` 仅写 `.brain/goal.md` |
| **P3c** | ✅ | [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) + deps 规则守门 |

其余（未开工）：

1. **`@utlra/inner-runtime`**（拟）：从 `packages/server` 抽出 `pi-mono/` + `openkuroneko/` 执行面，`agentServer` 只保留 outer + spawn。
2. **桥接层薄化**：`discord-bridge` / `webchat-bridge` 只做 ChatIR ↔ 传输，不含业务。
3. **每个模块一个「入口文件」**：与 `horizon.in` 对齐，便于 AI 与 CI 扫描。

每步 PR：先改 DSL → `validate` + `inspect` → 再改代码。

---

## 日常命令

```bat
cd /d d:\kuroneko\doc\structurizr
validate.bat
inspect.bat
local.bat
```

---

## 修订

| 日期 | 说明 |
|------|------|
| 2026-05-19 | 初版：P0–P4，P1 模块模型 |
| 2026-05-20 | P3a：workspace-kit 内联，移除 `@utlra/core` 包 |
| 2026-05-21 | CI：`.github/workflows/ci.yml` + `ensure-war.mjs` |
| 2026-05-21 | `COMPONENT-TEST-MAP.md`：ADL 模块 ↔ testing-strategy §4 |
