# Collatz（3n+1）· Lean · Harness-RSI 试点

> **English:** Minimal loop to exercise **periodic harness analyze** on an **open** conjecture, using Lean 4 `lake build` as the mechanical craft gate — **not** a truth oracle.
>
> **状态**：2026-09-16 · C ✅ · **E / P5 Loop-Source ✅**  
> **关联**：[`HARNESS-RSI.md`](./HARNESS-RSI.md) §4 / §12 / H9–H12 · [`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)

---

## 1. 选题

**Collatz conjecture（3n+1）**：正整数按偶÷2、奇 3n+1 迭代是否必到 1。仍为开放问题；本试点**不**以证完为成功标准。

---

## 2. 形态：专用最小 loop（真 harness 模块）

| 要 | 不要（本阶段） |
|----|----------------|
| 复用 `harnessAnalyze` / `revise` / `gate` / `pointer` | 新开完整外脑 + KPI + IM |
| 本机 workDir `.brain/harness/`（含 **P5 `trees/`**） | 新申请 mem9 / drive9（可选以后） |
| `lake build` + loop **自检**作工艺门控 | 用「猜想为真」当 gate |
| 周期 cadence 复盘；**revise 改 loop 源码** | 仅失败才 RSI；仅涨 skillRefs |

路径根：`experiments/collatz-lean-rsi/`（Lean 工程 + loop 脚本）。

---

## 3. 闭环

### 3.1 C（已跑通但 harness 曾无行为增益）

```text
exploration tick → lake build → RSI（曾：仅并 skillRefs）
```

### 3.2 E / HARNESS-RSI P5（现行）

```text
seed loopTree（assault-loop / run-loop / loop-meta ∈ tree）
  → tick：resolveActiveLoopEntry（H10）
  → lake / gateChecks
  → revise：patches 改 tree（无 tree diff → H12 拒绝）
  → gate → upgrade → 下一轮读新 loopTreeId
```

**可证伪**：upgrade 后 `loopTreeId` 不变仅 skillRefs 变长；或执行面不读 tree。

---

## 4. Lean 约定

| 文件 | 角色 |
|------|------|
| `Collatz/Conjecture.lean` | 猜想陈述；主定理可长期 `sorry` |
| `Collatz/Exploration.lean` | 工艺面引理；≠ harness 进化 |
| `loop-meta.ts` | P5 `loopEntry`；RSI patches 递增 `assaultEpoch` |
| `lake build` | 门控命令之一 |

---

## 5. 密钥

LLM：本机 `deploy/agent/env/collatz-lean.env`（gitignore）。**不**提交明文。

---

## 6. 阶段

| 步 | 内容 | 状态 |
|----|------|------|
| A–C | 骨架 + loop + Exploration 冲击 | ✅ |
| D | （可选）完整 Amadues agent / KPI | — |
| **E** | P5：`loopTree` + patches；`loopTreeId` 随 upgrade 变化 | ✅ |

### E 纪要（2026-09-16）

| 项 | 结果 |
|----|------|
| seed | `loop-meta.ts` + assault/run-loop → tree |
| 每 round | patches 写 `assaultEpoch` / `lastNote` |
| 验证 | upgrade 后 `loopTreeId` 与 entry 内容变化；H12 拒 skillRefs-only |
