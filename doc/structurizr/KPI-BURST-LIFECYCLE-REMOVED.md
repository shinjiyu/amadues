# 已移除：KPI Burst Hooks 与 Registry Lifecycle Reconcile

> **English:** Removed failed "infinite loop" layers. KPI sustainability is **`kpiAdvancer` + heartbeat cadence** only; sprint-internal waits use **`wait_timer` + ChangeWatcher**.

**状态**：2026-06-07 起代码已删除；本文档替代原 hook/reconcile ADL 职责说明。

---

## 曾有的机制（已删）

| 模块 | 原意图 | 为何移除 |
|------|--------|----------|
| **kpiBurstHooks** (`processBurstExitForKpi`) | burst onExit：outcome 评估、idle streak、momentum、autoAchieve、**scheduleNextKpiBurst** | 与 **kpiAdvancer** 抢调度；空转续跑未解决 Shiro 类问题 |
| **kpiBurstOutcomeEvaluator** | LLM/规则评估 burst 成败 → 换 charter 续跑 | 仅服务 hooks；一并删除 |
| **registryLifecycleReconcile** | 周期扫 AWAITING/BLOCKED → 强行 DONE | 双状态机创可贴；与 ChangeWatcher 重叠 |
| **scheduleNextKpiBurst** (index) | onExit 立刻 spawn 下一 burst | 无 cadence/战略；已由 advancer 取代 |

---

## 保留的续航与唤醒

| 场景 | 机制 |
|------|------|
| **KPI 下一发 sprint** | `kpiAdvancer.tick`（心跳）+ IM `advanceKpi` |
| **sprint 内短等待** | 内脑 `wait_timer` → registry AWAITING → **ChangeWatcher** 到点 spawn |
| **等人类** | `awaitingNotify` + IM → **awaitingInboundResolver** → ChangeWatcher |
| **burst 终态** | `onExit` 写 registry（DONE/AWAITING/ERROR）；`countDeliverables` |
| **KPI 结案** | `kpiCompletionJudge.sweep`（心跳）；**不再** onExit autoAchieve |
| **执行史** | `burst-run-history`（由 advancer 路径写入，非 onExit hook） |

---

## onExit 最小契约

```
子进程 exit → readWorkerStatus → isBrainAwaitingAsync?
  → registry: ERROR | STOPPED | AWAITING | DONE
  → deliverableCount = countDeliverables(workDir)
  → DONE/AWAITING 时 completionNotify / awaitingNotify（有 originThread）
```

**禁止**：onExit 内 spawn、KPI charter 换向、registry 周期对账。
