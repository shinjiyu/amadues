# Collatz（3n+1）· 任务目标与 Harness-RSI 划界

> **English:** **Task goal = prove the Collatz (3n+1) conjecture in Lean.** Harness-RSI is an **orthogonal** self-repair channel for the loop tooling — it must not redefine success as “more lemmas” or “more upgrades.”
>
> **状态**：2026-09-16 目标重标定（证明优先；RSI 旁路）  
> **关联**：[`HARNESS-RSI.md`](./HARNESS-RSI.md) H9–H14 · 路径 `experiments/collatz-lean-rsi/`

---

## 1. 两套东西（禁止混谈）

| 层 | 是什么 | 成功标准 | 失败长什么样 |
|----|--------|----------|--------------|
| **任务（Agent 目标）** | **证明** `Collatz.conjecture`：`∀ n > 0, ReachesOne n` | 主定理 **无 `sorry`** 且 `lake build` 绿 | 只会堆 `ReachesOne 87` 之类有限事实、无证明计划 |
| **RSI（过程基建）** | loop 源码树自修（H13/H14） | 诊断到 **loop 工艺**问题才 patch（含空转） | 每轮涨 epoch；**对空转装瞎** |

**可证伪**：把 Exploration 定理数、RSI upgrade 次数、或 `lake` 绿次数当成「证明进展」。

---

## 2. Agent 行为契约

对 agent 而言，唯一业务目标是：**想办法证明 3n+1**。

1. 维护 `ProofPlan.md`（整体思路：分类、下降量、归约核、未关闭子目标）。
2. **先计划后引理**：Exploration 只允许服务当前计划的引理；禁止无计划的 `decide` 枚举刷屏。
3. 对 `Collatz/Conjecture.lean` 发起真实证明尝试（可分步；未完成可暂留 `sorry`，但必须推进计划）。
4. `lake build` 是**工艺约束**（改动须可编译），**不是**任务完成定义。

---

## 3. 闭环（双轨，互不冒充）

```text
每 round
  ├─【证明轨】读 ProofPlan + Conjecture + Exploration
  │     → LLM 提案：计划修订 / 计划型引理 / 主定理证明尝试
  │     → lake build（失败则回滚该提案）
  │     → 记录 proof 进展（sorry? 计划子目标?）
  │
  └─【RSI 轨】craft/loop 故障 **或证明轨空转**（H14）
        → proposeLoopPatches → 有则 revise/upgrade；无则跳过
        → 不得写入「证明成功」语义
        → 典型工艺：空 LLM 不重试；lake 拒稿后用绿 rebuild 盖掉 lastLog
```

---

## 4. 文件角色

| 文件 | 角色 |
|------|------|
| `Collatz/Conjecture.lean` | **证明目标**；最终须去掉 `sorry` |
| `ProofPlan.md` | 整体证明思路与未关闭子目标（任务状态） |
| `Collatz/Exploration.lean` | 仅计划服务引理；非成绩单 |
| `assault-loop.ts` / `loopTree` | 执行与 RSI；过程基建 |

---

## 5. 阶段

| 步 | 内容 | 状态 |
|----|------|------|
| 基建 P5/H13 | loopTree + 诊断修补 | ✅ |
| **G0** | ADL：目标=证明；RSI 划界 | ✅ 本文 |
| **G1** | assault 证明轨 + 计划优先；去掉枚举即成功 | ✅ `assault-loop.ts` 双轨；失败不回滚 ProofPlan |
| **G1b** | H14 空转诊断（拒稿日志 / 空 LLM 重试） | ✅ |
| **G1c** | 100 轮长跑复盘 + 证明路线对比（§6/§7） | ✅ 本文 |
| G2 | （可选）挂完整内脑 agent / KPI=`prove-collatz` | — |

开放问题仍可能长期无法证完；**允许证不出，不允许用刷小定理假装在证。**

---

## 6. 长跑复盘（2026-09-16，100 轮）

日志 `.brain/prove-long-20260916-134051.log` · 日记 `.brain/proof-journal.jsonl`。

### 6.1 轮次分布（可审计）

| 本轮实际发生 | 轮数 |
|--------------|------|
| **只改 `ProofPlan`，未提任何 Lean** | **43** |
| 提了 Lean 被 `lake` 拒（含 6 轮连 Exploration 一起拒） | 37 |
| 空 LLM / 空提案 / fetch 失败 | 17 |
| **Lean 真落地** | **3**（round 12 / 17 / 35） |

落地内容：`odd_descent_1mod4`（3 步）、`odd_descent_3mod16`（6 步）、`odd_descent_23mod32`（8 步）。  
round 35 之后 65 轮**零落地**；Exploration 全程零落地。`odd_descent` 仍余 5 个开放分支（`n % 32 ∈ {7,11,15,27,31}`）。

### 6.2 三个诊断结论

1. **主要浪费是「只改计划」，不是编译失败**（43 > 37）。计划churn 不产出可验证物。
2. **RSI 旁路从未收到失败信号**：83 条进度全 `lakeOk: true`，收尾 stamp `ok=true`。原因是回滚后又跑一次绿 build 覆盖 `lastLog` ⇒ 诊断输入被清零。故 H14 中**保留拒稿日志**是关键修复，单纯放宽触发无效。
3. **agent 在计划里写了假的不可行结论**：声称 `27/31 mod 32` 不存在有限下降证书。复算为假（深度 13 时 27 的子类 185/256、31 的 102/256 有证书）。harness **无任何机制核验计划断言** ⇒ 据此停工。

---

## 7. 为什么同余枚举不闭合（路线对比）

### 7.1 实测：覆盖率升、开放类数爆炸

对 `n = 2^D k + r` 前 \(D\) 步奇偶向量确定的仿射下降证书做穷举（判据可复现落地的 3 个证书）：

| \(D\) | 奇同余类 | 未覆盖类 | 未覆盖占比 |
|------|----------|----------|------------|
| 5 | 16 | 4 | 0.250 |
| 10 | 512 | 64 | 0.125 |
| 15 | 16 384 | 1 295 | 0.079 |
| 20 | 524 288 | **27 328** | 0.052 |

**占比降、绝对类数爆炸** ⇒ 有限 case split 永不闭合；能闭合就等于证完 Collatz。

### 7.2 这就是文献里的天花板

同余类 / 奇偶向量 / 密度是同一脉，天花板是**测度意义的「几乎所有」**，不是 \(\forall n\)：

- **Terras (1976)** / Everett：前 \(k\) 步奇偶向量 ↔ mod \(2^k\) 同余类；几乎所有整数有有限 stopping time，例外集密度 → 0。**我们 agent 做的正是它的手工版。**
- **Korec (1994)**：几乎所有 \(N\) 落到 \(N^\theta\) 以下，\(\theta > \log 3/\log 4\)。
- **Tao (2019)**，[arXiv:1909.03562](https://arxiv.org/abs/1909.03562)：任意 \(f\to\infty\)，对数密度意义下几乎所有 \(N\) 有 \(\mathrm{Col}_{\min}(N) < f(N)\)。Remark 1.4 明言：加强到「存在绝对常数 \(C_0\)」**难度近乎等于整个猜想**。障碍是 Collatz 动力学**不保持均匀测度**，两个「几乎所有」不能拼接。

**结论**：密度陈述与 Lean 里 `odd_descent` 要的 \(\forall n\) **不是同一类陈述**；差的不是工程量。

### 7.3 其它路线及其障碍

| 路线 | 代表工作 | 障碍 | 对 agent 友好度 |
|------|----------|------|-----------------|
| **重写系统终止性 + SAT 搜排序函数** | Yolcu–Aaronson–Heule，[arXiv:2105.14697](https://arxiv.org/abs/2105.14697)（JAR 2023）；终止性**等价于** Collatz | 只证出非平凡**弱化版**；一元表示系统已证无自然 matrix interpretation 证明 | **高**：有搜索空间 + 验证器，RSI 可改编码/维度/策略 |
| 2-adic 动力系统（共轭到移位） | Lagarias、Bernstein | 整数在 \(\mathbb{Z}_2\) 中**零测** ⇒ a.e. 传不到每个 \(n\) | 低 |
| 排除循环（Diophantine 逼近） | Steiner；Simons–de Weger \(m\)-cycle；Brox | 只封循环，不封发散 | 中：子目标真可证、可形式化 |
| 不可判定性边界 | Conway FRACTRAN；Kurtz–Simon | 广义 Collatz 含不可判定实例；3x+1 本身未知 | 非证明路线 |
| 模同余图 / De Bruijn 图 | Lagarias–de Weger | 整性条件**非半线性** ⇒ Presburger / 有限自动机式推理拿不下 | 低（**同余拆分即属此类**） |

### 7.4 对 RSI 的启示（可证伪）

| 若出现 | 则说明 |
|--------|--------|
| 继续在同余深度上加层并称之为「进展」 | 未吸收 §7.1；跑步机 |
| 计划里出现未核验的「不可行/已证明」断言且被据此停工 | 缺**计划断言核验**层（§6.2.3） |
| 空转轮次只靠工艺补丁消化，纲领从不被否决/更换 | 停在 RSI **L1**（执行人类写死的改进），见 [`The Last AI Built by Humans`](https://arxiv.org/abs/2609.11873) L1–L5 |
