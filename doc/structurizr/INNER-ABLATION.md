# 内脑消融实验（Inner Ablation）· 第一轮：DyFlow 编排层 vs 单节点 ReAct

> **English:** Controlled ablation of the DyFlow orchestration layer. Arm A runs the full inner brain (Designer → Runner → Attributor → failure distill → redesign loop → Harness-RSI). Arm B runs the *same* Runner on a fixed one-node DAG (`preset/base`, instruction = goal): same LLM, same tool registry, same baseNode ReAct loop, same mechanical acceptance — and nothing above it. Outcomes are judged by an external grader the agent never sees.

> **状态**：2026-10-15 实现 ✅ · 第一轮已跑完（§10）
> **关联**：[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md)（被消融的对象）· [`HARNESS-RSI-NEGATIVE-RESULTS.md`](./HARNESS-RSI-NEGATIVE-RESULTS.md)（已有的论证型否定结论）· [`TOOL-MDL-GROWTH-RESULTS.md`](./TOOL-MDL-GROWTH-RESULTS.md)（实验写法参照：多种子、臂对照、先报方差）· [`LLM-USAGE-JOURNAL.md`](./LLM-USAGE-JOURNAL.md)（token 计量来源）

---

## 1. 问题

内脑结构复杂。第一轮只回答一个问题：

> 在同一模型、同一工具、同一 baseNode 执行器、同一机械验票下，**DyFlow 编排层**（Designer 拆图、Attributor 归因、失败蒸馏、多轮重设计、Harness-RSI）是否比「把整个目标交给一个 baseNode 做到底」**完成得更多**，代价是多少 token。

只有当 A 明显赢过 B，才值得进入第二轮去逐个拆编排层内部的模块；若 B 不输，编排层在这批任务上没有证明自己的必要性。

## 2. 两组（arm）

| 臂 | 名称 | 入口 | 保留 | 去掉 |
|----|------|------|------|------|
| **A** | `dyflow` | `runOpenKuronekoPiMonoAuto`（与生产同一函数） | 全部 | — |
| **B** | `single` | `runSingleNodeBaselineInWorkDir` → `runSingleNodeBaseline` → `runLocalDag` | Runner 的 baseNode 派发（memory 工具 + keychain 工具扩充、技能加载）、`runBaseNode` ReAct、§6.7 验票、shell stall guard、fail-fast、上下文治理 | Designer、`local_dag` 多节点、Attributor、失败蒸馏、重设计循环、Harness-RSI / held-out、plan reference |

B 的单节点 DAG：

```json
{ "burstId": "<burst>", "nodes": [{ "id": "single", "ref": "preset/base", "instruction": "<memory.goal>" }] }
```

B 跑完一次 `runLocalDag` 即结束，不重试。`preset/base` 提示词里「上交 Designer」的措辞保留不改：这正是「DyFlow 去掉编排层」的样子，改提示词会引入第二个变量。

## 3. 控制变量

| 项 | 做法 |
|----|------|
| 模型 | 两臂同一 `ZHIPU_*` 配置（`inner-llm-step.ts`），同一 `thinking` |
| 工具 | 两臂共用 `createInnerRuntime` 构造的 executor 工具注册表 |
| 外部记忆 | `DRIVE9_API_KEY`、`MEM9_API_KEY` 在子进程中清空；运行器启动时若 `~/.drive9/config` 存在则拒跑（`resolveDrive9Config` 会自动读它） |
| 跨运行污染 | 每次运行独立 `UTLRA_DATA_ROOT=<run>/data`，工作目录 `<run>/data/workspaces/<task-…>`；用量日志、工具审计、plan reference 都只看得到本次运行 |
| 技能池 | `OPENKURONEKO_OB_SKILL_POOL` 清空 |
| 初始状态 | 每次运行从任务 fixture 全新复制 |
| 进程隔离 | 每次运行一个子进程（独立进程组，与生产 worker 一致）；子进程退出或超时后杀掉整个进程组（模拟 burst 结束回收），之后才判分 |
| 并发互扰 | agent 习惯用 `pkill -f <脚本名>` 清场；起同名进程的任务标同一 `exclusiveGroup`，运行器不让同组并发 |

## 4. 预算

| 臂 | 上限 | 默认 |
|----|------|------|
| A | `maxTicks` + 墙钟 | 60 tick · 25 min |
| B | `INNER_BASE_NODE_MAX_ROUNDS` + 墙钟 | 150 轮（生产默认 50 的 3 倍）· 25 min |

预算不强求相等；报告同时给通过率和 token，二者一起读。

## 5. 判分

- 每个任务自带 **grader**（`grade(workDir) → { pass, checks[] }`），在子进程退出后由运行器在父进程执行。
- grader 代码不在工作目录里，不进提示词；判的是工作目录里的真实产物，不看 agent 的自述、不看 deliverables 登记。
- 任务还可声明 **不可修改文件**（hash 比对），防止改测试/改夹具过关。

## 6. 指标

| 指标 | 来源 |
|------|------|
| `pass` | grader |
| `promptTokens` / `completionTokens` / `totalTokens` / `llmCalls` | `<data>/usage/llm-usage.jsonl` |
| `toolCalls`（按 module：base-node / designer） | `<data>/inner/tool-logs/<ws>/*.jsonl` 的 `tool.call`（Designer 自身的 commit/report 工具不进审计，编排开销看 `llmCalls`/token） |
| `wallMs`、`exit`（ok / error / timeout） | 运行器 |
| A：`finalMode`、`dagCount`、`ticks` | `.brain/dyflow-state.json`、`memory.dag_history`、worker 结果 |
| B：`nodeStatus`（ok / failed / capped） | `.run/single-node-baseline.json` |

汇总：每任务 × 每臂的通过次数 / 重复次数、token 中位数；总表给每臂通过率与「每次通过的 token」。

## 7. 任务集

来源：kuroneko 生产历史（`data-kuroneko/inner-brain-registry.json`）。挑选规则：

1. 本机可独立复现：不依赖那台机器上的常驻服务、launchd、账号或私有网络；需要的环境写成 fixture。
2. 可机械判分：有确定的正确产物，grader 能跑出来。
3. 多步：至少需要「探查 → 定位 → 修改 → 验证」中的三步，否则编排层没有发挥空间。
4. 单次运行在 25 分钟内可以完成。

具体任务清单与出处记在 `experiments/inner-ablation/README.md`。

## 8. 判读规则（事先写定）

- 每任务每臂至少 3 次重复；先报**每任务**结果，再报总表。
- A 的总通过次数比 B 多 **≥ 2 个任务的全部重复**，才算编排层在这批任务上「有效」；否则记「未证明必要」。
- 无论胜负都报每次通过的 token；A 胜但 token 翻倍以上，也写进结论。
- 结果写入本篇 §10（结果）一节，不另开文件。

## 9. 组件

| 模块 ID | 职责 | 主路径 | In → Out |
|---------|------|--------|----------|
| **innerRuntimeFactory** | 构造内脑运行时依赖（LLM、executor 工具表、logger、技能、drive9 共享、plan reference）；run-tick 与基线共用 | `packages/server/src/pi-mono/inner-runtime.ts` | workspaceId + workDir → `InnerRuntime` |
| **singleNodeBaseline** | 单节点基线：seed preset + goal → 固定一节点 DAG → `runLocalDag` → 落 `.run/single-node-baseline.json` | `packages/server/src/openkuroneko/inner-brain/single-node-baseline.ts` | workDir + deps → `SingleNodeBaselineResult` |
| **singleNodeBaselineEntry** | 用 `createInnerRuntime` 组装依赖后调 `runSingleNodeBaseline` | `packages/server/src/pi-mono/run-single-node.ts` | workspaceId + workDir → result |
| **innerAblationHarness** | 任务 fixture、子进程派发、超时、grader、指标汇总、报告 | `experiments/inner-ablation/` | tasks × arms × repeats → `report.json` / `report.md` |

## 10. 结果

### 10.1 第一轮（2026-10-15，glm-5.3，thinking=disabled，4 任务 × 2 臂 × 3 次）

产物：`experiments/inner-ablation/runs/round1/report.{md,json}`（不入库）。

| 任务 | dyflow 通过 | single 通过 | token 中位 dyflow / single | 墙钟中位 dyflow / single |
|---|---|---|---|---|
| reward-standing-exploit | 3/3 | 3/3 | 967k / 271k | 13.1m / 2.1m |
| service-survives-session | 3/3 | **0/3** | 339k / 904k | 5.9m / 12.8m |
| viz-frontend-not-moving | 3/3 | 3/3 | 446k / 638k | 7.4m / 5.9m |
| viz-leg-layout | 3/3 | 2/3 | 352k / 104k | 5.2m / 1.2m |
| **合计** | **12/12** | **8/12** | 总 6.19M / 6.10M；每次通过 515k / 763k | |

**判读（§8 事先规则）**：A 多 4 次通过，门槛是 2×3=6 → **未证明必要（not_shown_necessary）**。Fisher 精确检验 12/12 vs 8/12 双侧 p≈0.09。

**读法**：

- 差距几乎全在一个任务上。`service-survives-session`（会话结束后服务要活下来）single 三次全挂，dyflow 三次全过。dyflow 的 Designer 把「进程组会被回收」写成首节点硬约束（setsid / 双 fork），再排一个独立复核节点（查 PPID=1、curl 状态）。single 三次都走 launchd，撞上 macOS 隐私保护（launchd 读不了 `~/Documents`）：r1 把服务拷到 `/tmp` 跑（判分要求从工作目录跑，判不过；放宽此条则 12/12 vs 9/12，p≈0.22）；r2 起不来；r3 本来成功，最后一步「验证重启」时自己 `launchctl unload` 了服务，没再拉起，自述成功。这正是编排层宣称的价值：拆出的复核节点不信执行者自述。
- 另一处失败（leg-layout single r2）：腿朝向自作主张加了外八字（与仿真不符），随后 `shell_exec_bg` 传了不存在的 cwd，**worker 进程直接崩溃**（见 10.2）。
- 两臂都能做的三个任务里，dyflow 在两个上贵 3–4 倍、慢 4–6 倍（reward、leg-layout），在一个上更省（frontend，single 有一次 122 次工具调用的长跑）。
- 总 token 两臂几乎相同；dyflow 的「每次通过 token」更低，是因为 single 的失败运行很贵（service 失败中位 904k）。

**结论**：这批任务上，编排层的通过率优势方向一致（从未输过 single）但没过事先门槛；它的价值集中在「执行者容易自我欺骗 / 需要独立复核」的运维型任务，在单点修 bug 型任务上主要是成本。要下更硬的结论需要更多此类任务和更多重复。

### 10.2 跑实验时发现的问题

| 问题 | 影响 | 处理 |
|---|---|---|
| `spawnBackground`（`openkuroneko/process/exec-runner.ts`）没监听子进程 `error` 事件；cwd 不存在时 Node 抛未捕获异常，**整个内脑 worker 崩溃** | 生产同样会崩；两臂共享 | 待修（不在实验中途改，避免前后条件不一致） |
| agent 会执行 `killall -9 node`（service single r1），把宿主上所有 node 进程（含运行器）一起杀掉 | 第一次 round1 中断；用户其它 node 进程受波及 | 运行器与 worker 改用改名二进制 `abl-node`；PATH 前插 killall/pkill 垫片拒绝按名整杀 node |
| agent 写 `~/Library/LaunchAgents`、`launchctl bootstrap`、往 `/tmp` 拷服务 | 宿主残留、KeepAlive 会在判分后继续拉起 | 每次运行后 `cleanupHostResidue` 按工作目录路径回收 launchd / plist / crontab / 进程；`/tmp` 拷贝不在回收范围，需人工清 |
| agent 习惯 `pkill -f 'node viz/server.cjs'` 清场 | 同名服务的并发运行互相误杀 | `exclusiveGroup` 互斥调度 |
