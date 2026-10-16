# 最小 ReAct + 工具 MDL 自生长（Tool-MDL Growth）

> **English:** A **frozen** minimal ReAct kernel over a single terminal action (`shell_exec`), plus an **offline** grammar-induction pass that mines frequent action subsequences from the trace log and promotes them into tools. Tool creation is a **compression** decision (MDL over the action-log corpus), **not** a model judgement. Capability is never extended — only cost distance is contracted.

> **状态**：2026-09-17 ADL 初稿 · P0 实现 ⏳
> **关联**：[`HARNESS-RSI-NEGATIVE-RESULTS.md`](./HARNESS-RSI-NEGATIVE-RESULTS.md)（**本篇的论证前史**：为什么 loop 层不该 RSI、为什么位点是工具层）· [`HARNESS-RSI.md`](./HARNESS-RSI.md)（本篇是对 P5 loop-source RSI 的**否定性结论**之后的替代设计）· [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §7b（固化两层）· [`COLLATZ-LEAN-RSI.md`](./COLLATZ-LEAN-RSI.md) §6（长跑复盘）· [`TERMINOLOGY.md`](./TERMINOLOGY.md)
> **历史对照（勿按文实现）**：[`doc/todo/dyflow-tool-promotion.md`](../todo/dyflow-tool-promotion.md)（T0 `ws_*` 注册 0 次 / 调用 0 次，整层移除）

---

## 1. 动机

### 1.1 已被证伪的两条路

| 尝试 | 结果 | 根因 |
|------|------|------|
| **harness 自改写**（HARNESS-RSI P5：revise 全量 loop 源码） | Collatz 100 轮：43 轮只改计划，RSI 从未收到失败信号；每一次有效改进的作者都是人 | 自改写相对「固定循环 + 可变数据」**不增加可达性**；且其正确性只能统计地认证，而认证不可付（见 §3.2） |
| **内联 `create_tool`**（dyflow T0 `register_workspace_script_tool`） | 生产 bot2：**注册 0 次、调用 0 次**，整层移除 | 复发只在**跨任务的日志层面**可见；图里任何单个节点都不具备做这个判断所需的观测。不是模型不愿判断，是**没有参与者看得见重复** |

### 1.2 结论

把「何时造工具」从**判断题**改成**压缩题**：

- 候选生成 = 动作日志上的**频繁子序列挖掘**（机械）
- 接受判据 = **MDL 增量**（可计算，无先验）
- 验收 = **历史实例重放**（确定性，逐个可判定）
- 退役 = **同一个 MDL 目标**（删除使总描述长度下降则退役）
- 模型只做**反合一 + 写函数体**，不决定造不造

### 1.3 这不是能力提升

`create_tool` 不扩张原语闭包，它扩张的是**可寻址动作词汇**；闭包内一个原本需要 50 步 ReAct 到达的点变成 1 个动作。**度量是 token 成本，不是能力。** 真正的闭包增长只来自**获取外部接口**（装二进制 / 凭据 / 网络），那是权限问题，见 M9。

---

## 2. 范围

### 2.1 In

| 表面 | 说明 |
|------|------|
| `tools/<name>/` 目录树 | 工具库；**唯一**可自生长的面 |
| 动作日志 `runs/<runId>/trace.jsonl` | 挖掘语料；append-only |
| MDL 账本 `tools/.mdl.json` | 文法代价 / 语料代价 / 接受-退役历史 |

### 2.2 Out（冻结，永不进上下文）

| 表面 | 说明 |
|------|------|
| **ReAct 内核源码** | M1。内核不读自己、不写自己、不发给模型 |
| 原语动作集 \(A_{prim}\) | 只有 `shell_exec`；增减须人类改内核 |
| 工具索引的构建规则 | 元层由内核**固定约定**提供（索引 = `tools/` 目录的函数），不是一个动作 |
| 本 ADL / benchmark 定义 | 人类/仓库权威 |

---

## 3. 权威词

| 词 | 含义 |
|----|------|
| **终结符（terminal）** | 真正作用于环境的原语。本设计中 \(\Sigma=\{\texttt{shell\_exec}\}\)；挖掘时以 `argv[0]` 为符号 |
| **非终结符（nonterminal）** | 一个被创建的工具；它 = 一个名字 + 一条产生式 |
| **产生式** | 工具体：该非终结符如何展开为终结符（或其它非终结符）序列 |
| **元层操作** | 作用于**动作词汇表**而非环境的操作。`create_tool` 属此层，**由内核约定实现**，不是内循环动作 |
| **内循环** | 在线、冻结、跑单个任务的 ReAct；动作空间 = `shell_exec` + 当前工具索引 |
| **外循环** | 离线、每 N 个任务一次：重编码 → 挖掘 → 反合一 → 重放 → MDL 收录 → MDL 退役 |
| **重编码（re-encoding）** | 挖掘前先用当前工具库改写历史日志。**不做这步就永远只有深度 1**，见 M8 |
| **文法代价 \(c_{carry}\)** | 工具索引条目占用的 token；**每轮都付**。对应 utility problem（Minton 1988） |
| **语料代价** | 全部轨迹用当前库表达后的 token 总量；主项是**进入上下文的观测 token** |
| **获取型工具** | 需要网络 / 装二进制 / 凭据的工具。它扩张 \(A_{prim}\)，不是压缩，单独记账（M9） |

非正式同义禁止：把「模型调用了一次 `create_tool`」叫自生长（那是对照臂 A，见 M11）；把「工具数量增长」叫成功（M6 要求同时可退役）；把获取型工具带来的成本下降算进压缩归因（M9）。

---

## 4. 闭环

### 4.1 内循环（在线 · 冻结）

```text
context = [ task, toolIndex(tools/), history(bounded) ]      # 内核源码不在其中（M1）
loop:
  (thought, action) = llm(context)
  obs               = execute(action)                         # shell_exec 或某个工具
  appendTrace({ runId, step, symbol, args, obsDigest,
                obsTokens, inTokens, outTokens })             # M3
  history += (action, summarize(obs))                         # 观测有上限
until done | budget exhausted
```

### 4.2 外循环（离线 · 每 N 个任务）

```text
corpus  = reEncode(traces, library)          # M8：先用当前库重写，否则无层级
cands   = mine(corpus, minSupport, minGain)  # 机械；min-gain 不可省（M4）
for c in cands:
  τ = llm.antiUnify(c)                       # 模型唯一职责：泛化 + 写函数体
  if !replay(τ, c.instances): reject         # M5：确定性闸门
  if mdlDelta(accept τ) >= 0: reject         # M4：压缩不为负才收
  accept(τ)                                  # 写 tools/<name>/，含 tests.jsonl
for τ in library:                            # M6：同一目标管退役
  if mdlDelta(remove τ) < 0: retire(τ)       # 尊重 deps DAG
```

### 4.3 MDL 目标

\[
L \;=\; \underbrace{\sum_{\tau\in\text{lib}} \big(|\text{manifest}(\tau)|_{\text{tok}}\cdot S\big)}_{\text{文法代价（每轮都付）}} \;+\; \underbrace{\sum_{t\in\text{corpus}} |t|_{\text{tok}}}_{\text{语料代价}}
\]

\(S\) = 剩余步数预算。收录 \(\tau\) 当且仅当 \(\Delta L<0\)。这与 §1.2 的经济不等式等价：

\[
k\,(c_{\text{inline}}-c_{\text{tool}}) \;>\; c_{\text{build}}+c_{\text{carry}}\cdot S
\]

---

## 5. 存储

```text
<workDir>/
  tools/
    .mdl.json                 # { grammarCost, corpusCost, history[] }
    <name>/
      manifest.json           # name, description(≤M7 上限), args schema, deps[], kind
      run                     # 可执行：stdin JSON args → stdout {summary, artifacts}
      tests.jsonl             # 重放夹具：挖掘实例的 (args, expected) 对
  runs/<runId>/
    trace.jsonl               # 结构化动作日志（M3）
    cost.json                 # { actionTokens, observationTokens, steps }
```

```typescript
interface ToolManifest {
  name: string;
  description: string;                 // token 数 ≤ descriptionTokenBudget（M7）
  args: Record<string, { type: 'string' | 'number' | 'boolean'; required?: boolean }>;
  deps: string[];                      // 依赖的其它工具名；退役须尊重（M6）
  kind: 'composition' | 'acquisition'; // M9：获取型默认禁止
  createdAt: string;
  minedFrom?: { symbols: string[]; support: number; savedTokensPerUse?: number };
}

interface TraceRecord {
  runId: string;
  step: number;
  symbol: string;                      // argv[0] 或工具名（挖掘字母表）
  args: Record<string, unknown>;       // 结构化；字符串 blob 不合法（M3）
  obsDigest: string;
  obsTokens: number;                   // 进入上下文的观测 token（主项，M10）
  actionTokens: number;
  ok: boolean;
}
```

---

## 6. 模块（ADL）

| 模块 ID | 职责 | 路径（目标） | 阶段 |
|---------|------|--------------|------|
| **actionLog** | `TraceRecord` schema / append / 读；`argv[0]` 符号抽取与参数规范化 | `openkuroneko/tool-mdl/action-log.ts` | ✅ P0 |
| **toolManifest** | manifest 解析 + 校验：描述 token 上限（M7）、kind 分类（M9）、args schema | `openkuroneko/tool-mdl/tool-manifest.ts` | ✅ P0 |
| **toolIndex** | 扫 `tools/` → 内循环词汇表 + 文法代价 token 计量 | `openkuroneko/tool-mdl/tool-index.ts` | ✅ P0 |
| **mdlAccount** | 文法代价 / 语料代价 / 收录与退役的 \(\Delta L\) | `openkuroneko/tool-mdl/mdl-account.ts` | ✅ P0 |
| **traceMiner** | 重编码 + 频繁子序列挖掘（min-support **与** min-gain） | `openkuroneko/tool-mdl/trace-miner.ts` | ✅ P0 |
| **reactKernel** | 冻结内循环：注入式 LLM / executor；有界观测；写 trace | `openkuroneko/tool-mdl/react-kernel.ts` | ✅ P0 |
| **toolReplayGate** | 拿 `tests.jsonl` 重放候选工具（executor 注入）；**M5a** provenance 强制独立推导；**M5b** 效果摘要构造（产物 / 事实投影） | `openkuroneko/tool-mdl/tool-replay-gate.ts` | ✅ P1 |
| **toolLibrary** | deps DAG；accept / retire 的落盘与顺序约束 | `openkuroneko/tool-mdl/tool-library.ts` | ✅ P1 |
| **growthCycle** | 外循环编排：reEncode→mine→antiUnify→replay→MDL | `openkuroneko/tool-mdl/growth-cycle.ts` | ✅ P1 |

**实验驱动（不在 packages）**：`experiments/minimal-react-mdl/`（benchmark 任务族 + run-loop），沿用 `collatz-lean-rsi` 的独立目录惯例。

**证据状态摘要**（勿把设计当成战果）：[`TOOL-MDL-GROWTH-RESULTS.md`](./TOOL-MDL-GROWTH-RESULTS.md)。逐次踩坑见本文 §11。

---

## 7. 不变量

| ID | 不变量 |
|----|--------|
| **M1** | **内核冻结**：ReAct 内核源码不进上下文、不被任何动作写入。自改写在本设计中**不存在** |
| **M2** | \(A_{prim}=\{\texttt{shell\_exec}\}\)。元层（工具索引构建）由内核**固定约定**提供；`create_tool` 不是内循环动作（对照臂 A 除外，M11） |
| **M3** | trace 必须结构化：`symbol` + **规范化参数字典**。参数存成单条字符串即违规——反合一无法进行，且事后补不回来 |
| **M4** | 收录判据**机械**：min-support **且** min-gain **且** \(\Delta L<0\)。模型不得决定造不造，只做反合一与写函数体 |
| **M5** | 未通过 `tests.jsonl` 重放的候选**不得**收录；夹具与工具同目录存放，构成永久回归 |
| **M5a** | 夹具 `expected` 必须**独立于候选工具本身**推导。拿候选自己跑一遍的输出当期望值，闸门恒过、等于没有（P2 实测踩中） |
| **M5b** | M5 是**效果等价**，不是观测等价。工具的目的就是让观测变短，所以不得拿原始观测文本当 `expected`；`runner` 须上报可验证的**效果**摘要，比对在效果上进行。纯只读工具无产物，其「效果」是观测的**信息投影**（抽出的事实集），投影函数由端口按域提供，闸门本身只做字符串相等 |
| **M6** | 退役与收录用**同一个** MDL 目标；退役须尊重 `deps` DAG，不得删除仍被依赖的工具 |
| **M7** | manifest `description` 有 **token 硬上限**；超限拒绝收录。文法代价每轮都付，不能靠自觉 |
| **M8** | 每轮挖掘前**必须**用当前库重编码日志。跳过此步 ⇒ 层级深度恒为 1，工具永不调用工具 |
| **M9** | `kind='acquisition'` 的工具**默认禁止**，须显式开闸并**单独记账**；其带来的成本下降**不得**计入压缩归因 |
| **M10** | 成本必须分两项记：`actionTokens` 与 `observationTokens`。只记总数不合法——主项是被工具吞掉的中间观测。记的是**进入上下文**的量（截断后），不是执行器产出量；记错会让 `savedTokensPerUse` 把从未付过的成本算成可省（P2 实测，§11.8） |
| **M11** | 对照臂 A（内联 `create_tool`，模型判断）与臂 B（离线挖掘，机械）必须可**分别开关**且归因不混合。理论预测 A≈0；**A 若有效则本 ADL 的核心论断被证伪** |
| **M12** | 获取/组合之分必须下沉到**被挖掘的每一步**，不能只标在成品工具的 `kind` 上。获取步的观测**就是它的价值**，信息仍须送达 agent，因此**不可压缩**；把它的 `obsTokens` 记入 `savedTokensPerUse` 会系统性高估 ΔL，让必然亏本的工具通过闸门（P2 实测击穿，见 §11） |
| **M13** | 退役时若工具**仍被调用**，节省必须用**收录时锁定的** `savedTokensPerUse`，不得从当前语料的 `minedFrom.symbols` 回算。采用后表面复发被折叠，回算恒为 0 → 刚成功的工具被误杀（§11.15） |

---

## 8. 可证伪信号

理论预测与对照表。**多条不符 ⇒ 动作轨迹不具备文法归纳假设的序列结构，那本身是本实验最有价值的发现。**

| 若出现 | 则 |
|--------|-----|
| 工具使用**不是**重尾分布（调用均匀分散） | 与文法归纳的频次分布不符；挖掘对象可能不是真正的复发单元 |
| 超过半数新工具创建后使用 ≤1 次 | 收录阈值太松（min-gain 需上调） |
| 成本曲线平滑衰减而非**阶梯** | 测错了量（压缩收益应在高频规则命中时离散跳变） |
| 大台阶不在前期 | 与贪心合并（BPE 序）矛盾；挖掘顺序可能有 bug |
| 库变大后每任务成本**未**回升 | 未正确计入文法代价；M7/M10 计量失效 |
| 拐点与「索引 token ≈ 节省的观测 token」预测不符 | MDL 账本公式与实际计费口径不一致 |
| 层级深度恒为 1 | 违 M8（未重编码） |
| 候选接受率很高 | 伪频繁片段未被 MDL 闸门过滤；min-gain 失效 |
| 成本下降主要来自 `kind='acquisition'` 工具 | 违 M9；这不是压缩，归因被污染 |
| 内核源码出现在任何 prompt 里 | 违 M1 |
| trace 的 `args` 是字符串 blob | 违 M3；外循环无法进行 |
| 收录后的工具在线调用即失败、模型退回原始 shell | 反合一只产出了函数体、**没产出每实例的参数绑定**；且夹具违 M5a，闸门是自指的 |
| 对照臂 A 显著有效 | **核心论断被证伪**（M11）——「造工具是压缩题不是判断题」不成立 |

---

## 9. Benchmark 前置条件

本机制**严格是回顾性的**：挖掘只能发现已复发的东西。因此：

| 要求 | 说明 |
|------|------|
| **确定性** | 输出可精确比对；接受判据逐任务可判定 |
| **复发结构** | 任务流必须有共享子序列。**无复发 ⇒ 无压缩 ⇒ 无增益**，这是前置条件不是待修缺陷 |
| **成本可计量** | 模型 API 须返回 usage |
| **中间观测占主导** | 光是「观测大」不够。大在**获取步**上的观测不可压缩（M12），任何工具都省不掉。必须是**可丢弃的中间观测**占成本主项——典型形态是 agent 要翻阅大批候选、看完即弃 |

> 最后一条是 P2 补上的。原文只写「观测足够大」，于是我把任务族设计成「读一份很贵的
> schema」——而那恰好是唯一不可压缩的那类观测。机制给出的正确答案是「什么都不建」，
> 于是这套 benchmark 根本无法检验正面命题。见 §11.6。

**P0 benchmark**：合成的数据/文件加工任务族（「从匹配 Y 的日志抽出所有 X，输出 CSV」），**复发结构由人精确植入**。第一步只验证一件事：挖掘能否把种进去的片段挖出来。挖不出则停止，不必往真实任务流走。

> Collatz 不满足本节要求（单个非确定性任务、无复发结构），这解释了 [`COLLATZ-LEAN-RSI.md`](./COLLATZ-LEAN-RSI.md) §6 中 100 轮零产出：**机制需要的信号，那个试验台给不出来**。

---

## 10. 阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P0** | 本专篇 + catalog/CTM；`actionLog` / `toolManifest` / `toolIndex` / `mdlAccount` / `traceMiner` / `reactKernel` + 单测 | ✅ |
| **P1** | `toolReplayGate` / `toolLibrary`（deps DAG）/ `growthCycle` 外循环编排 + 端到端组件测 | ✅ |
| **P2** | `experiments/minimal-react-mdl/`：植入复发的合成任务族 + 真实 LLM 跑通；验证 §8 前四条 | 🔶 跑通，**核心预测被证伪**，见 §11 |
| **P3** | 对照臂 A（内联 `create_tool`）接线；A/B 归因分离（M11） | ✅ 理论预测 A≈0 未被推翻，见 §11.13 |
| **P4** | 真实任务流；utility problem 拐点实测与 §4.3 预测比对 | ⏳ |

---

## 11. P2 实测：命中的可证伪信号

实验：[`experiments/minimal-react-mdl/`](../../experiments/minimal-react-mdl/)，glm-5.3，6 任务 × 4 批。
任务族满足 §9 三条前置（确定性验收、植入复发、观测占成本 94%）。

**结论：机制全程跑通，但核心预测「每任务成本单调下降」被证伪。** 成本反向上升
（12 → 18 步，观测 2525 → 4331 token），正确率不变（6/6）。三个根因，按发现顺序：

### 11.1 M5 闸门曾经是自指的（已修，补 M5a/M5b）

第一版把「候选工具自己跑一遍的输出」当 `expected`，闸门恒过。于是一个 awk 列引用
写错的工具被收录，上线即失败，模型退回原始 shell —— 步数上升。

修正后闸门做**效果等价**（产物 `out.csv` 的行数 + 摘要，期望值由**原始实例重跑**独立
推导）。它随即抓住了模型反合一的一个典型语义错误：把列号绑成字符串 `"$2"`，
awk 里 `$m` 把 `"$2"` 强转为 0，静默退化成整行比较，产物恒空。

> **闸门在做真活**。同一类工具在闸门自指时被放行、在效果等价下被拦住。这一条支持
> ADL 的核心论断：收录判据必须机械，模型判断会放过看似合理的错误泛化。

### 11.2 反合一需要闸门反馈的修复环（已修）

首发泛化不可靠。把失配信息（expected/actual 效果摘要 + awk 强转的提示）喂回模型，
一轮修复即通过。**未接修复环时机制产出恒为零**——候选全被拒，库永远是空的。

### 11.3 `savedTokensPerUse` 系统性高估 ΔL（未修，见 M12）

被收录工具的自述是 *"Show schema and log preview, filter log rows by level, extract
column, sort to out.csv"* —— 它把 `cat schema` 那一步**一起**封装了，于是每次调用
都重新吐出 409–439 token 的 schema。模型的实际行为变成三步：自己 `cat schema` →
调工具（又一次 409 token）→ 仍然自己跑 awk。成本翻倍。

根因不在模型，在目标函数：

```
savedTokensPerUse(instance) = Σ_steps (actionTokens + obsTokens)   # 现状
```

对 `cat→awk` 这个候选，被计入的 409 token 全部来自 `cat schema`。而
**`cat schema` 是获取步：它的观测就是它的价值**，信息必须送达 agent，封装进工具
也省不掉。能压缩的只有「中间产物型」观测。核算把不可压缩的部分记成了节省，
ΔL 从 +134（诚实值，应拒）变成 −1331（高估，误收）。

这正是 §7 M9 的 composition/acquisition 之分——只是它原先只标在**成品工具**的
`kind` 上，而挖掘的字母表对**单步**的获取/组合毫无区分。故补 **M12**。

附带现象：accept → retire → accept 的 churn（批 1 收录、批 2 库空、批 2 又收录一个
同义工具），因为高估的 ΔL 在不同批次的 support 下符号翻转。

### 11.4 账本视界口径（已修）

`carry = manifestCostTokens × remainingSteps` 必须与 `support` 同窗口。把
`remainingSteps` 传成预算上限（`budgetSteps × tasks`）会把携带成本高估数倍，
好工具被误拒为 `mdl_not_negative`。正确取值是「下一批预期步数 ≈ 刚跑完这批的实际步数」。

### 11.5 M12 已实现（方案 c）

`TraceRecord.obsKind: 'acquisition' | 'intermediate'`，由 `reactKernel` 在 run 结束时
**机械**回填（判定要看后续动作，故只能回填，`rewriteTrace` 因此存在）。判据：

> 观测 i 首次引入、且出现在后续某个动作参数里的 token —— 说明 agent 真的从这条
> 观测里取走了信息 ⇒ 获取步。取不走信息的观测就是中间产物，可被工具吞掉。

只用 token 集合的差与交，可复算、可测，不是模型判断。列引用 `$2` 这类单字符后缀
必须能成词，故 tokenizer 含 `$`。已知局限：agent 若在后续动作里回显中间结果会误判为
获取步，方向保守（少记节省，宁拒不误收）。

`savedTokensPerUse` 随之不再计入 `obsKind === 'acquisition'` 的 `obsTokens`。
缺 `obsKind` 的旧 trace 按 `intermediate` 处理（向后兼容）。

**实测效果**：`cat→awk` 候选在批 1/2 稳定被拒为 `mdl_not_negative`，误收消失、成本不再
膨胀（12 步持平）、accept→retire→accept 的 churn 消失，正确率不变。

### 11.6 但这套任务族无法检验正面命题

修好之后库**全程为空**——机制在这个任务族上拒绝建任何东西。**这是正确判决**：
唯一的复发片段 `cat schema → awk` 里，`cat schema` 是获取步（409 token 不可压缩），
`awk` 那步的观测只有 5 token（`wc` 输出）。每次使用真正可省的不过 ~5 观测 + ~30 动作
token，付不起 37 token/步 的 manifest 携带成本。ΔL ≥ 0 是对的。

于是得到一条比「成本下降」更硬的结论：

> 真实模型两步就把任务做完了，贵的那部分是**不可约的信息获取**。这种任务上没有
> 任何工具能帮忙——不是机制不行，是**没有可压缩的东西**。

这同时说明 §9 原本的前置条件不足：需要的不是「观测大」，而是「**中间**观测大」。
要检验正面命题，任务族得改成 agent 必须翻阅大批中间结果、看完即弃的形态
（多轮检索/筛选），而不是读一份很贵的 schema。

### 11.7 任务族 v2（reports 族）：正面命题仍未被证实

`experiments/minimal-react-mdl/tasks-reports.ts`。报告里的延迟数字写成**英文单词**，
awk/sort 做不了词形数字的比较 ⇒ 模型必须真的读；读完只留一个「超没超阈值」的判断
⇒ 报告正文作废 ⇒ `obsKind` 判为 `intermediate` ⇒ 这部分才可压缩。能压缩的是机械那半截
（把 40 行样板里那一句捞出来，330 → ~12 token），词形换算仍留给模型。

前置条件这次满足了，机制也终于收录了工具（`cat_grep_truncate`，ΔL=−10040），
obs/已解任务 1142 → 987。**但这不能算证实**，三条理由：

1. **工具几乎没被调用**：批 2 调 1 次，批 3 调 0 次。命中 §8 的「新工具创建后使用 ≤1 次
   ⇒ 收录阈值太松」。那 13.6% 的下降与工具无关。
2. **批间方差远大于效应**：obs/已解任务四批分别 1142 / 1891 / 1550 / 987，n=4 下 13.6%
   读不出趋势。任何成本结论都需要更多批次与重复跑。
3. **ΔL=−10040 是高估**，根因见 11.8。

### 11.8 `obsTokens` 记的是截断前的量（已修）

`createTraceRecord` 拿**执行器产出**算 `obsTokens`，而内核自己的成本计数器用的是
**截断后**进上下文的 `shown`。模型一旦 `cat reports/rep-*.txt`（31k 字符，截断到 4k），
trace 就记下 7854 token，其中七分之六从未进过上下文。`savedTokensPerUse` 直接吃这个
字段，于是把从未付过的成本算成「可省」，ΔL 荒谬地偏负。

M10 记的是**上下文成本**，不是执行器产出量。修法：`createTraceRecord` 增
`shownObservation`，`obsTokens` 由它计；`obsDigest` 仍按完整观测算（否则截断会把不同
产出混为一谈）。

> 附带观察：模型会用 glob 把 24 份报告一次性 `cat` 出来，然后在被截断的观测上猜答案
> —— 正确率因此在 3/6 与 6/6 之间跳。**「一行流 + 截断」是真实 agent 的一种失败模式**，
> 与本机制无关，但会污染任何以成本为指标的实验。

### 11.9 三种子 × 四批：一个干净的正例，但 n=1

加了两件仪表后重跑（reports 族，min-gain 12，3 种子 × 4 批 × 6 任务）：

- **`toolCalls`**：学到的工具被实际调用的次数。缺这一列时成本曲线不可信——
  收录了但没人调用，曲线的任何变化都与机制无关。
- **`obsPerSolved`**：按已解任务归一。失败的任务往往更短，不归一会把正确率波动
  读成成本下降。驱动器在「效应 < 批内离散」或「工具零调用」时直接打印警告。

| 种子 | 批 2（无工具） | 批 3 | 结果 |
|------|---------------|------|------|
| 4242 | 1111，6/6 | **798，6/6，toolCalls=6** | 收录 `scan_latency_reports`，**每个任务都调用** |
| 4249 | 1263，5/6 | 1152，5/6，toolCalls=0 | 无候选过闸，成本平 |
| 4256 | 1068，5/6 | 1407，3/6，toolCalls=0 | 无候选过闸，成本平 |

种子 4242 是机制**第一次完整成立**的实例：同一任务集内，工具收录 → 6/6 任务全部调用
→ obs/已解降 28% → 正确率不降。因果结构是对的。

**但 n=1，聚合读不出趋势**（效应 195，最大批内离散 5127）。离散的主来源是正确率波动：
有一批只解出 1/6，obs/已解冲到 6091。**正确率方差是当前测量的约束瓶颈**，不是机制。

### 11.10 min-gain 是「接受率 ↔ 实际复用」的旋钮（实测两侧）

| min-gain | 收录 | 实际调用 |
|----------|------|---------|
| 4 | 每批都收 | **≤1 次**（§8 命中「阈值太松」） |
| 12 | 3 种子里只有 1 个收到 | **6/6 任务全调用** |

这就是 utility problem 在实测里的样子：阈值压低了误收，同时也把接受率压到了
三分之一。**两侧都量到了**，这比任何一侧的单点数字都更有信息量。

模型一行流化使挖出的实例只有 2–3 个符号，`gainOf = (support−1)×length` 因此常常
够不到 12 —— 这是接受率低的直接原因，也再次指向「`shell_exec` 作为唯一终结符时，
模型的上下文内组合已经覆盖了文法归纳能建出来的大部分东西」。

### 11.11 内核须**事先**告知观测上限

不告知时模型会用 glob 一次性 dump（`cat reports/rep-*.txt`，31k 字符），然后在被截断的
观测上猜答案——正确率因此在 3/6 与 6/6 间跳，成本指标被污染。截断标记只在观测**之后**
出现，模型事前无从知晓。

`buildPrompt` 曾固定输出 `OBSERVATION LIMIT: ...`。**§11.14 析因后收回默认开**：
在 reports 族上单独打开就会零收录且正确率不升。选项保留（`announceObservationLimit`），
默认关。

> 「截断要事先告知」作为通用 agent 卫生建议仍可能成立，但与本机制需要的多步轨迹冲突。

### 11.12 降难度让机制彻底失效 —— 步数就是载体

为把正确率抬到 ~100%（§11.9 说方差是瓶颈），把 per-task 从 4 降到 3 并加了 §11.11 的
观测上限告知，跑 3 种子 × 6 批：

| | 原配置（per-task 4） | 降难度后（per-task 3 + 上限告知） |
|---|---|---|
| 每批步数 | 16–18 | **9–10** |
| 每任务步数 | ~2.8 | **~1.5** |
| 收录工具 | 1/3 种子收到并被全调用 | **3/3 种子零收录，零调用** |
| 正确率 | 4.67/6 | **4.33/6（更差）** |
| obs/已解 | 1314 → 1119 | 943 → 1080（反向） |

两个结论：

1. **步数是这套机制的载体。** 每任务 ~1.5 步时没有可挖的复发，`gainOf = (support−1)×length`
   恒不过闸，库永远是空的。压缩需要有东西可压。
2. **降难度会被模型的上下文内组合吸收，不会流向工具库。** 任务一变简单，模型就把它
   一行流化；省下来的成本进了模型的即时组合，而不是沉淀成可复用的工具。

> 这是本 ADL 核心赌注最锋利的一处脆弱性：`shell_exec` 已是极强的组合装置，
> 只有当任务**迫使**模型多步交互时，离线文法归纳才有可挖的东西。
> 与用户先前的判断一致——harness 不提升能力，只缩短搜索距离。

**方法论自省**：这一轮同时改了两个变量（per-task 与上限告知），因此无法归因是哪一个
导致步数塌缩。默认已回退到 per-task 4；上限告知保留（原则上正确），但两者需分开重跑
才能定论。正确率**未**因降难度改善，说明 §11.9 里「截断导致正确率崩塌」的假设至少不完整。

### 11.13 P3 对照臂 A：理论预测 A≈0 未被推翻

同一任务族、同一三种子（4242 / 4249 / 4256）、四批 × 六任务。臂 A 把 `create_tool`
放进内循环动作空间，由模型当场判断是否造工具——没有挖掘、没有 ΔL、没有重放闸门。

| 臂 | create_tool 调用 | 库中工具 | 学到的工具被调用 | 完整正例 |
|----|------------------|---------|----------------|---------|
| **A**（内联判断） | **0 / 72 任务** | 0 | 0 | 无 |
| **B**（离线挖掘，同种子） | n/a | 1/3 种子收到 | 6/6 任务全调用 | 种子 4242（§11.9） |

相对结论对方差不敏感：臂 A 在 72 个任务上**一次都没想过造工具**。这与
[`dyflow-tool-promotion.md`](../todo/dyflow-tool-promotion.md) 的生产零注册一致，
也是 M11 的预测。

接线细节（不是稻草人）：

- 宣告的签名含 `args`——无参工具天然不可复用，那是给臂 A 设套
- 形式合法性仍检查（manifest schema / M7 / M9），否则噪声是「模型写不出合法工具」
- **重放闸门的缺席是内在的**：臂 A 前瞻造工具，造的那一刻还没有历史实例；臂 B 回顾
  造，所以才有夹具。这条不对称本身就是 M11 要量的东西之一

> 臂 A 有效 ⇒ 本 ADL 的核心论断被证伪。本次实测未发生。

### 11.14 析因：per-task × 观测上限告知 —— 任一因子单独就够打死

§11.12 同时改了两个变量。补跑缺失两格（同三种子 / 四批 / min-gain 12）：

| | 观测上限告知 **关** | 观测上限告知 **开** |
|---|---|---|
| **per-task=4** | §11.9：1/3 种子收录并 6/6 调用；步数 ~16–18 | **本格**：3/3 零收录；步数塌到 ~6–13；正确率更差 |
| **per-task=3** | **本格**：3/3 零收录；步数 ~10；正确率反而更好 (~5/6) | §11.12：3/3 零收录；步数 ~9–10 |

两条独立结论：

1. **观测上限告知单独就会把机制打死**（同行对照：per-task=4 关→开）。
   模型被提示「输出装不下就分步」后，反而更激进地一行流化 / 少步猜答案；
   可挖复发消失，且正确率**没有**因告知而改善——§11.11 的「原则上正确」在本任务族上不成立。
2. **降 per-task 单独也会打死**（同列对照：告知关时 4→3）。
   步数载体不够，与 §11.12 一致。

> 默认已改回：`announceObservationLimit` 默认关；实验用 `--obs-limit-notice` 显式打开。
> 「截断要事先告知」作为通用 agent 卫生建议仍可能成立，但**与本机制的信号条件冲突**——
> 本机制要的是多步、可挖的轨迹，告知会把轨迹压扁。

### 11.15 正确默认下 5 种子：正例可复现，但不稳且会退役

配置：per-task=4、告知关、min-gain=12、5 种子 × 4 批（含原先的 4242/4249/4256）。

| 种子 | 收录 | 随后 | 备注 |
|------|------|------|------|
| 4242 | 无 | — | **同种子曾在 §11.9 给出完整正例** —— LLM 非确定性 |
| 4249 | 无 | — | |
| 4256 | 候选被 `replay_failed` | — | 闸门在拦 |
| **4263** | `scan_reports_latency`（ΔL=−5702） | 批 1：toolCalls=**5**，obs/solved 1273→**641**；批 2：**退役** | 因果链再次出现，但只活一批 |
| 4270 | 无 | — | |

汇总：5 种子中 **1** 个出现「收录→高复用→成本降」；同一种子不保证可复现；收录后会因后续 batch 的 support 翻转被 MDL 退役（utility problem 的另一面）。聚合效应 −40、批内离散 871，仍读不出趋势。

> 正面命题从「n=1 轶事」升级为「**可复现的稀有事件**（约 1/5）」，仍不是统计上的普遍产出。

### 11.16 退役误杀：采用后回算 minedFrom 恒为 0（已修，M13）

§11.15 的种子 4263：批 1 调用 5 次后，批 2 生长周期把工具**退役**了。根因：

```
retire.savedTokensPerUse = savedTokensPerUse(occurrencesOf(traces, minedFrom.symbols))
```

采用后语料里是 `scan_reports_latency`，不再有 `cat→grep`，回算节省 = 0，
`retireDelta = 0 - carry < 0` ⇒ 误杀。

修法：收录时把 `savedTokensPerUse` 写入 `manifest.minedFrom`；退役时若 `uses > 0`
用锁定值，仅当从未调用才允许从当前语料回算。

### 11.17 M13 后 5 种子：本轮零收录，误杀修复未被触发

同配置再跑 5 种子：5/5 库为空。唯一候选 `grep_latency_summarize` 被 `replay_failed` 拒掉。
聚合 obs/solved 1617 → 1168（效应 449 < 批内离散 1989），驱动器判定与机制无关。

**M13 是代码修正，不是新的正面证据。** 接受率仍受 LLM 非确定性支配；本轮没有工具活过闸门，
因此「采用后不再误杀」尚未在真实 LLM 上复验。

### 11.18 反合一合同与效果摘要不一致（已修）

§11.17 的唯一候选死于 `replay_failed`，但失败信息几乎没用：修复提示还在讲 schema 族的
awk `$2` 强转，而 reports 族的闸门要比的是 `facts=id=words`。与此同时，提示要求
「不要回显中间输出」——模型照做，stdout 就匹配不上投影，`actual` 为空。

修法（实验端口，不是核心闸门）：把**独立重跑得到的效果摘要**写进反合一提示，并规定
`facts=` 用 `id: words` 行、`artifact=` 写同名文件。失配行默认打印，不再藏在 `--verbose` 后。

### 11.19 合同修复未被触发：候选在 min-gain 之前就没了

同三种子、修正后的反合一提示再跑：3/3 库为空，**一次 growth 拒绝都没有**。
抽查种子 4242 批 0：6 个任务的轨迹长度是 3,2,2,3,1，符号是 `cat` / `grep` / `:`。
`gain = (support−1)×length`，min-gain=12 时长度 2 的对需要 support≥7，而这批最多 6 个任务且形状不齐。
候选在挖掘阶段就被丢掉，反合一合同根本没执行。

聚合 obs/solved 1207 → 1538（效应为负，且小于批内离散）。

> 当前瓶颈仍是「轨迹太短、形状不齐，过不了 min-gain」，不是闸门文案。
> 驱动器现已在候选数为 0 时也打印 `[growth]`，避免把「没挖到」读成静默成功。

### 11.20 per-task=6：唯一过闸前候选死于空文件合取

2 种子 × 每任务 6 份报告。多数周期 `cands=0`。种子 4249 有一个
`grep_latency_facts`，重放失败：

```
expected = artifact=out.csv lines=0 sha=e3b0c442… facts=ab=one hundred twenty|…
actual   = artifact=out.csv lines=0 sha=e3b0c442…
```

空 `out.csv`（`: > out.csv`）的 sha 对所有实例相同，没有判别力，却和事实合取。
工具复现了空文件、没打出 `id: words`，闸门拒绝。聚合效应 865 仍小于离散 2591，库为空。

已从效果摘要里丢掉空白产物。空文件不再挡事实比对。

### 11.21 §11.20 验证轮：零候选，修复未被触发

同配置（per-task=6、3 种子 × 4 批）再跑：全部生长周期 `cands=0`。
上一轮种子 4249 那种 `grep_latency_facts` 没有复现。效应 788 ≈ 批内离散 889，
库为空、零调用——与机制无关。

**空白产物修复因此仍只是代码级修正，没有真实 LLM 上的对照验证。**
再在同一格子上加种子，边际信息量已经很小；下一步应换旋钮（min-gain）或动作空间，而不是继续同配置重跑。

### 11.22 staged 探针：先要重复子序列，先不比 token

reports 族的真实轨迹经常是 1–3 步一行流，`gain=(support−1)×length` 过不了 min-gain=12，候选在挖掘阶段就是 0。在这种语料上比较有无工具的 token，比的是同一条空库曲线。

本探针只回答一个问题：**机械禁止「一条命令写完最终产物」之后，轨迹里会不会出现跨任务对齐的长度 ≥2 子序列。** 成本对照留到 `cands>0` 且工具被调用之后。

合同在实验执行器，不在内核（`experiments/minimal-react-mdl/stage-gate.ts`）：

| 规则 | 违反则回滚 |
|------|------------|
| 一条 shell 最多改动 `work/s1.txt`、`work/s2.txt`、`out.csv` 之一 | 一步写完三个文件 |
| `work/s2.txt` 仅当 `work/s1.txt` 已存在 | 跳步 |
| `out.csv` 仅当 s1 与 s2 都已存在 | 直接写最终产物 |

任务同构：`inbox/batch-k.txt` 里的 `MARK <id> <integer>`，留下第三字段 `> 500` 的 id，排序写入 `out.csv`。提示词**不**指定二进制；脚本化 agent 固定走 `grep→awk→sort`，只用来确认挖掘器在序列对齐时能看见候选。6 任务、长度 3、每任务一次：`gain=(6−1)×3=15 ≥ 12`。真实模型若仍各写各的 `python3`，候选可以仍是 0——那就是探针的否定结果，不是接线故障。

`--family=staged`。产物目录用 `--outdir=`，避免覆盖 reports 族的 `.run/`。

**实测（glm-5.3，1 种子 × 2 批 × 6 任务，min-gain=12）**：合同生效。6/6 任务都是三条命令，没有一步写完 `out.csv`。符号对齐为 `mkdir→awk→sort`（第一条实际是 `mkdir && grep … > work/s1.txt`，`argv[0]` 只记到 `mkdir`）。挖掘器给出 1 个候选 `filter_mark_sort_to_csv`，反合一写了函数体，**MDL 拒绝**（`mdl_not_negative`）。原因：重定向把中间表留在磁盘上，进入上下文的观测大约每步 3 token、每题约 26 token，折成工具省不下文法代价。库为空，零调用。obs/solved 26→16 与机制无关。

> 探针把「没有候选」推进到了「有候选但不够省」。若再改合同强迫中间表进入观测，ΔL 由构造为负，那不是测试。该下一步收回，见 §11.23。

### 11.23 DeepSWE 原题：只观察会不会生成工具

不再设计合成题，也不改执行器去凑节省。题来自 [DeepSWE](https://deepswe.datacurve.ai)（`datacurve-ai/deep-swe`），只用 `instruction.md` 与 `task.toml` 里的仓库和 `base_commit`。不使用 Pier，不使用其 agent，不把 `solution/` 放进工作区。

跑的是本仓库冻结的 shell ReAct（臂 B）。一批互不相同的题（默认按 `task_id` 排序的前 4 个 Python 题）各走一遍，步数预算 30。挖掘、min-gain=12、重放、ΔL 都不改阈值。效果摘要改为相对 base commit 的 `git diff`（这些题没有 `out.csv`；沿用 CSV 闸门会把任何候选判成无法验收）。读出只有：符号序列、过闸候选、是否收录、若收录则再跑同一批看调用次数。空库是允许的结果。

驱动：`experiments/minimal-react-mdl/run-deepswe.ts`。

**实测（glm-5.3，4 个按 task_id 排序的 Python 题，预算 40 步）**：库为空，零调用。四题都没有改代码、没有提交；模型读完文件就结束，提醒「还没提交」最多四次后仍结束。过 min-gain 的重复片段是翻页读文件（`sed→sed`，以及 `cd && …` 被记成一串 `cd`）。重放时相对 base commit 没有 diff，反合一放弃，没有收录。

停机认的是模型的 `done`，空的 `git status` 又像在确认做完了。随后把完成改成「相对 base commit 有提交才接受 `done`」，拒绝原因写进观测；`cd` 在仓库内保持、不许走出仓库；提示只保留最近 8 步。这是让循环真的改代码，不是为了凑工具节省。

---

## 12. 测试

| 类型 | 文件 | 覆盖 |
|------|------|------|
| 单元 | `action-log.test.ts` | schema 校验；`argv[0]` 符号抽取；参数规范化；拒绝字符串 blob（M3）✅ |
| 单元 | `tool-manifest.test.ts` | 描述 token 上限（M7）；kind 分类（M9）；args schema ✅ |
| 单元 | `tool-index.test.ts` | 目录扫描 → 词汇表；文法代价计量；渲染不泄漏函数体/路径 ✅ |
| 单元 | `mdl-account.test.ts` | \(\Delta L\) 收录/退役；拐点计算 ✅ |
| 单元 | `trace-miner.test.ts` | 植入片段可被挖出；min-support/min-gain；重编码后出层级（M8）✅ |
| 单元 | `react-kernel.test.ts` | 冻结（M1：内核源码不进 prompt）；对照臂 A 开关（M11）；有界观测；trace 落盘；预算耗尽 ✅ |
| 单元 | `tool-replay-gate.test.ts` | 重放通过/失败；空夹具不得放行（M5）；provenance 强制（M5a）；效果摘要构造（M5b）✅ |
| 单元 | `tool-library.test.ts` | accept 落盘；deps 必须已存在；退役被依赖者拒绝（M6）；`.mdl.json` 历史 ✅ |
| 单元 | `growth-cycle.test.ts` | 挖出→收录；四条拒绝路径；`maxAcceptPerCycle`；重编码出层级；退役 ✅ |
| 组件 | `toolMdlGrowth.component.integration.test.ts` | 外循环端到端：植入复发 → 挖出 → 收录 → **步数折半、观测 token 降一个数量级**；无复发则库为空 ✅ |

| 实验 | `experiments/minimal-react-mdl/` | P2：真实 LLM（glm-5.3）+ 植入复发的合成任务族；`--fake` 离线冒烟；`--arm=a` 对照臂；`--family=staged` 分阶段探针（§11.22）🔶 |

> **实测（组件测）**：4 个共享 `grep→jq` 的任务，收录后步数由 8 降到 4，进入上下文的观测 token 降到原来的 1/10 以下，且归因为 `kind='composition'`、`minedFrom=['grep','jq']` 的自建工具（M9 未被污染）。
>
> **但组件测的 agent 行为是脚本化的。** 换成真实 LLM 后同一套机制给出相反结果，见 §11——
> 组件测之所以绿，是因为它同时替机制假定了「模型会恰好用工具替掉那几步」和
> 「被折叠的观测都是可压缩的」。后者被 M12 推翻。

---

## 13. 理论出处

| 用到的 | 出处 |
|--------|------|
| 终结符 / 非终结符 / 产生式 | Chomsky 1956，形式文法 |
| 从序列归纳 CFG（本机制的最小可理解形式） | SEQUITUR：Nevill-Manning & Witten 1997 |
| 贪心合并高频对 | BPE：Gage 1994；Sennrich et al. 2016 |
| 最小文法问题 NP-hard 与近似比 | Charikar et al. 2005 |
| MDL 目标 | Rissanen 1978 |
| 把具体片段泛化成带参工具 | anti-unification：Plotkin 1970；Reynolds 1970 |
| 库学习在真实系统上的完整形态 | DreamCoder：Ellis et al. 2021 |
| **utility problem**（学到的宏反而拖慢系统） | Minton 1988 / 1990 |
| 更早的同形前例 | STRIPS MACROPs：Fikes, Hart & Nilsson 1972；SOAR chunking：Laird et al. 1986；options：Sutton, Precup & Singh 1999 |
| 「自改写可被固定解释器 + 可变数据模拟」 | Kleene 第二递归定理 1938；3-Lisp 反射塔：B. C. Smith 1982 |
| 「定义是保守扩张」 | definitional extension（数理逻辑） |

---

## 14. 修订

| 日期 | 说明 |
|------|------|
| 2026-09-17 | 初稿：最小 ReAct（单终结符）+ 离线文法归纳长工具；M1–M11；与 HARNESS-RSI P5 自改写、dyflow T0 内联 `create_tool` 两条已证伪路线划界 |
| 2026-09-17 | **P0+P1 实现** ✅：九个模块 + 97 用例（94 单测 / 3 组件测）。端到端验证成本下降且归因干净。**注意**：组件测里模型对新词汇的利用是脚本化的，验证的是机制（索引→少步→少观测），不是模型行为；真实 LLM 与真实任务流见 P2 |
| 2026-09-17 | **P2 真实 LLM 实测** 🔶：机制跑通，**核心预测被证伪**（成本反向上升）。补 M5a/M5b（闸门不得自指、M5 是效果等价）与 M12（获取/组合须下沉到单步）。§11 记录四个根因 |
| 2026-09-17 | **M12 实现**（方案 c：`obsKind` 由内核机械回填）+ 6 条用例（108 绿）。误收与 churn 消失、成本不再膨胀。但库全程为空且**这是正确判决**——该任务族的贵观测恰是不可压缩的获取步，故 §9 补第四条前置「**中间**观测占主导」，正面命题待新任务族检验（§11.6） |
| 2026-09-17 | **任务族 v2（reports 族）**：前置条件满足，机制首次收录出工具。但**正面命题仍未证实**——工具几乎不被调用、批间方差远大于效应（§11.7）。修 M10 计量口径（`obsTokens` 记截断后，§11.8），补 M5b 的只读工具投影式效果。109 绿 |
| 2026-09-17 | **加仪表 + 多种子重跑**（`toolCalls` / `obsPerSolved` / 效应-离散护栏）：种子 4242 给出机制**第一个完整正例**——收录 → 6/6 任务全调用 → obs/已解降 28% → 正确率不降（§11.9）。但 n=1，聚合仍读不出趋势，瓶颈是**正确率方差**而非机制。§11.10 记下 min-gain 在「接受率 ↔ 实际复用」上的两侧实测 |
| 2026-09-17 | **降难度的尝试失败**（§11.12）：per-task 4→3 + 观测上限告知（§11.11）后每任务步数塌到 ~1.5，**3/3 种子零收录**，正确率还更差。得到两条硬结论——步数是机制的载体；降难度会被模型的上下文内组合吸收、不会沉淀成工具。默认已回退 |
| 2026-09-17 | **P3 对照臂 A** ✅（§11.13）：同三种子下 `create_tool` 在 72 个任务上调用 0 次。理论预测 A≈0 未被推翻。相对结论对方差不敏感；与 dyflow T0 生产零注册一致 |
| 2026-09-17 | **M5a/M5b 上移进核心**：`validateAcceptFixtures` / `buildFixturesFromOriginal` / 效果摘要构造进 `toolReplayGate`；`growthCycle` 收录前强制校验 provenance。118 绿 |
| 2026-09-17 | 证据状态摘要篇 [`TOOL-MDL-GROWTH-RESULTS.md`](./TOOL-MDL-GROWTH-RESULTS.md)；回写否定性专篇 §7 |
| 2026-09-17 | **§11.14 析因**：per-task × 观测上限告知 2×2。任一因子单独即可零收录；§11.11「默认告知」收回，默认改回关 |
| 2026-09-18 | **§11.15**：正确默认下 5 种子重跑。1/5 出现完整因果链后又退役；原正例种子 4242 本次零产出（非确定性） |
| 2026-09-18 | **M13 / §11.16**：退役不得在采用后从已折叠的 minedFrom 回算节省；收录时锁定 `savedTokensPerUse` |
| 2026-09-20 | **§11.17**：M13 后 5 种子零收录；误杀修复未被真实 LLM 触发 |
| 2026-09-20 | **§11.18**：反合一提示与 reports 族效果摘要对齐；replay 失配默认打印 |
| 2026-09-20 | **§11.19**：3 种子合同修复未被触发——轨迹过短，候选过不了 min-gain；零候选也打印 |
| 2026-09-20 | **§11.20**：per-task=6 唯一候选因空 out.csv 与 facts 合取而 replay 失败；空白产物不再进入效果摘要 |
| 2026-09-20 | **§11.21**：§11.20 验证轮 3 种子零候选；空白产物修复未被触发；同格重跑收益已尽 |
| 2026-09-20 | **§11.22**：staged 探针。执行器回滚「一条命令写完 s1+s2+out.csv」。glm-5.3 上 6/6 对齐为 `mkdir→awk→sort`，挖出 1 个候选，因观测被重定向、ΔL≥0 未收录。强迫观测变贵的下一步收回 |
| 2026-09-20 | **§11.23**：DeepSWE 原题 4 道（glm-5.3）。只读、未改代码；`sed→sed` 等候选因无 diff 未收录。库为空 |
