# 建模粒度对齐说明

## 你的标准（我们采纳）

| 规则 | 含义 |
|------|------|
| **一模块 = 一件事** | 有独立 **Intention**，且有清晰 **In**（唯一入口 API/事件） |
| **内脑每一步处理器 = 模块** | DECOMPOSE / EXECUTE / ATTRIBUTE 各是一个模块；**反思（Reflexion）** 单独模块 |
| **外脑入站决策 = 模块** | 「是否说话 / SPEAK·SILENT」= `participationPolicy`，不是塞在 OuterBrain 里的一笔带过 |
| **进程边界 = 容器** | **agentServer 进程** 只放外脑模块；**innerWorker 子进程** 放 openkuroneko 阶段模块 |

## 与 P1 粗模型的差异（未对齐处）

| P1 粗组件 | 问题 | 应对 |
|-----------|------|------|
| `outerBrain` | 吞掉 participation、knowledge、orchestrator | 拆为 `participationPolicy`、`outerBrainFacade`、`knowledgeRetrieval` 等 |
| `outerTools` | 吞掉 registry、spawn、kpi | 拆为 `outerToolExecutor`、`innerBrainRegistry`、`innerSpawner`、`kpiRegistry`… |
| `openkuronekoCtrl` | 吞掉 decomposer/executor/attributor/reflexion | 移到 **innerWorker**，每阶段独立 component |
| `piMonoSpawner` | 与阶段混在一起 | 保留为 `innerSpawner`（外脑侧）+ `piMonoScheduler`（内脑侧） |

## 模块计数目标（O(1) 浏览）

| 视图 | 一次只看 | 大约模块数 |
|------|----------|------------|
| `07-L3-Outer-Inbound` | 入站 + 是否说话 + 外脑入口 | ≤7 |
| `08-L3-Outer-Orchestration` | 对话环、工具、spawn、KPI | ≤8 |
| `09-L3-Inner-Phases` | Controller + 三阶段 + 反思 | ≤8 |

详细契约见 [`modules-catalog.md`](./modules-catalog.md)。

## 代码 ↔ 模块 映射原则

- **主入口文件** 写在 `properties.path`（可多个用 `;` 分隔）
- **跨文件强耦合** 仍算一个模块（如 `inbound-policy` + `participation-state`）
- **禁止** 在 DSL 里用「文件夹名」当模块名；用 **职责名**
