# Collatz（3n+1）· Lean · Harness-RSI 试点

> **English:** Minimal loop to exercise **periodic harness analyze** on an **open** conjecture, using Lean 4 `lake build` as the mechanical craft gate — **not** a truth oracle.
>
> **状态**：2026-09-15 试点开搞  
> **关联**：[`HARNESS-RSI.md`](./HARNESS-RSI.md) §4 / H9 · [`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)

---

## 1. 选题

**Collatz conjecture（3n+1）**：正整数按偶÷2、奇 3n+1 迭代是否必到 1。仍为开放问题；本试点**不**以证完为成功标准。

---

## 2. 形态：专用最小 loop（真 harness 模块）

| 要 | 不要（本阶段） |
|----|----------------|
| 复用 `harnessAnalyze` / `revise` / `gate` / `pointer` | 新开完整外脑 + KPI + IM |
| 本机 workDir `.brain/harness/` | 新申请 mem9 / drive9（可选以后） |
| `lake build` 作工艺门控 | 用「猜想为真」当 gate |
| 周期 cadence 复盘 | 仅失败才 RSI |

路径根：`experiments/collatz-lean-rsi/`（Lean 工程 + loop 脚本）。

---

## 3. 闭环

```text
exploration tick（写/改 .lean 或跑检查）
  → lake build
       ├─ fail → 写 run-context(ok=false) → RSI 辅触发
       └─ ok  → stamp + run-context(ok=true) → cadence analyze
  → findings? → revise → gate（源文件存在 + build stamp）→ upgrade
```

**可证伪**：成功 N 轮从未出现 `trigger=cadence`；或 build 挂仍 upgrade。

---

## 4. Lean 约定

| 文件 | 角色 |
|------|------|
| `Collatz/Conjecture.lean` | 猜想陈述；主定理可长期 `sorry` |
| `Collatz/Exploration.lean` | 尝试引理 / 计算辅助；须保持可编译 |
| `lake build` | 门控命令（无 mathlib 依赖，启动快） |

---

## 5. 密钥

LLM（可选增强 analyze/写证明）：本机 `deploy/agent/env/collatz-lean.env`（gitignore），从私人备份库导入 `ZHIPU_API_KEY`。**不**提交明文。

---

## 6. 阶段

| 步 | 内容 | 状态 |
|----|------|------|
| A | ADL + Lean 骨架 + `lake build` 绿 | ✅ |
| B | 最小 loop 接真 harness 模块 | ✅ `experiments/collatz-lean-rsi/run-loop.ts` |
| B2 | cadence 上 actionable findings → upgrade（Lean craft skill 绑定） | ✅ |
| C | （可选）LLM 辅助 Exploration；再挂完整 agent | — |
