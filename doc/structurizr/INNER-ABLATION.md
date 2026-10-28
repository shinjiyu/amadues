# 内脑消融实验（Inner Ablation）· 第一轮：DyFlow 编排层 vs 单节点 ReAct

> **English:** Controlled ablation of the DyFlow orchestration layer. Arm A runs the full inner brain (Designer → Runner → Attributor → failure distill → redesign loop → Harness-RSI). Arm B runs the *same* Runner on a fixed one-node DAG (`preset/base`, instruction = goal): same LLM, same tool registry, same baseNode ReAct loop, same mechanical acceptance — and nothing above it. Outcomes are judged by an external grader the agent never sees.

> **状态**：2026-10-15 实现 ✅ · 四轮都已跑完（§10.1 / §10.4 / §10.6 / §10.8）。`runs/round1` 至 `runs/round4` 保留
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

第二轮（2026-10-17）不再限于六足研究线。挑选规则不变。第一轮 fixture 不改，`runs/round1` 不覆盖；新运行只写 `runs/round2`。

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

### 10.3 第二轮设计（2026-10-17 开跑前写定）

第一轮只覆盖六足一条线，通过率差距几乎集中在一个运维任务上。第二轮换一批更宽的题目，规则事先写定，再开跑。

- 数据：`experiments/inner-ablation/runs/round1` 原样保留。副本 `experiments/inner-ablation/archive/round1`（不含 `abl-node`，带 `SHA256SUMS`）。`report.json` 的 sha256 是 `628636dc97dd537691badd613e2b3dde64034f3e37a0b45c0828c65a80ee2444`。第二轮只写 `runs/round2`。
- 模型、两臂、预算、判分方式、§8 门槛都不变。门槛仍是「A 比 B 多出至少 2 个任务的全部重复」（3 次重复时为多 6 次通过），不按任务总数按比例放宽。
- 两轮分开判读。可以事后并排看，不把两轮运行混进同一份 `report.json`。
- familymac-mini（192.168.31.125）本次 SSH 仍被对端重置，没有新的生产实例可固化。题目按 §7 的四条新做，出处不冒充生产 id。

| 任务 | 类型 | 要修的东西 | 判分 |
|---|---|---|---|
| `ledger-refund-sign` | 对账 | CSV 引号，以及退款/手续费被记成收入 | 重跑脚本，对流水独立加总 |
| `catalog-page-slice` | 分页 | 每页少一条 | 任意数组按页拼回原序列 |
| `roster-no-overlap` | 排班 | 忽略时间重叠 | 约束满足即可，不要求唯一解 |
| `access-log-redact` | 脱敏 | 只去了邮箱 | 函数另测若干行，并重跑得到 clean.log |
| `shanghai-open-hours` | 时间 | 用 UTC 当当地时间 | 上海 UTC+8 工作日 09:00–17:00，含跨日 |

两臂条件与第一轮相同，实验中途不改执行器。

### 10.4 第二轮结果（2026-10-17，glm-5.3，thinking=disabled，5 任务 × 2 臂 × 3 次）

产物：`experiments/inner-ablation/runs/round2/report.{md,json}`，副本在 `archive/round2`。`report.json` 的 sha256 是 `c42c8469000e479bd3c7937a9fac8ffd1b19220aa400a491d72e0ce5936086fc`。30 次都正常退出。第一轮 640 个归档文件核对 sha256，无不一致。

| 任务 | dyflow 通过 | single 通过 | token 中位 dyflow / single | 墙钟中位 dyflow / single |
|---|---|---|---|---|
| ledger-refund-sign | 3/3 | 3/3 | 89k / 55k | 1.5m / 0.5m |
| catalog-page-slice | 3/3 | 3/3 | 292k / 52k | 3.3m / 0.3m |
| roster-no-overlap | 3/3 | 3/3 | 129k / 45k | 1.4m / 0.4m |
| access-log-redact | **2/3** | 3/3 | 144k / 54k | 1.5m / 0.4m |
| shanghai-open-hours | 3/3 | 3/3 | 186k / 53k | 7.1m / 0.2m |
| **合计** | **14/15** | **15/15** | 总 3.11M / 0.86M；每次通过 222k / 57k | |

**判读（§8，§10.3 重申）**：A 没有多出通过，反而少 1 次。门槛是多 6 次 → **未证明必要（not_shown_necessary）**。这一轮的点估计方向和第一轮相反。

**读法**：

- 五题都是单点修正：对账、分页、排班、脱敏、时区。single 三次全过，中位大约 45–55k token、十几秒到半分钟。
- dyflow 在四题上全过，在 `access-log-redact` r2 漏了一条。样例日志里的参数都在 `?` 或 `&` 后面；那次实现把 `token=` 限定在行首、`?` 或 `&` 之后，空格后面的 `token=zzz` 没被脱敏（`spec_lines` 6/7）。另外两次 dyflow 过了。
- 能做的题上，dyflow 中位 token 大约是 single 的 1.6–5.6 倍，墙钟大约是 3–30 倍。总 token 3.11M 对 0.86M。`shanghai-open-hours` 的 dyflow r3 用了 544k token、10.6 分钟，仍然只是改一个函数。
- 和 §10.1 放在一起：编排层的通过率优势出现在「执行者会把失败说成成功」的运维任务上；在这批边界写清楚的修正题上，单节点够用，编排层主要是成本。

**结论**：第二轮没有给编排层补上「有必要」的证据。题目一放宽到普通修正，single 通过率不低于 dyflow，token 大约是四分之一。

### 10.5 第三轮设计（2026-10-17 开跑前写定）

第二轮把故障位置和规则都写进目标之后，单节点足够。第三轮改成开放排查：目标只给现象和完成规则，不指出改哪个函数；工作区里放一份说得通但错误的笔记；只改对一半仍然过不了判分。要看的是编排层会不会少停在半路结论上。

这和「探测后台有没有问题」是同一类：要找的东西事先列不全，做的人容易拿一份局部证据宣布查完了。本轮用本地能判分的排查题，不把攻击步骤写进任务。

- 数据：`runs/round1`、`runs/round2` 不覆盖。本轮只写 `runs/round3`。
- 模型、两臂、预算、§8 门槛不变。A 要比 B 多出至少 6 次通过，才算编排层有效。
- 分开判读，不并进前两轮的 `report.json`。

| 任务 | 开放在哪 | 半路结论从哪来 | 判分 |
|---|---|---|---|
| `close-day-drift` | 日结对不上，不说是作废还是日期切错 | 笔记说已经修好，剩下的是四舍五入 | 上海日历日、作废不计；再塞一张收据重跑 |
| `intake-silent-drop` | 有的提交没出现 | 笔记说加号邮箱和带 BOM 的文件本来就该丢 | 每个文件恰有一个结局；再加一份提交重跑 |
| `notes-search-gap` | 正文里有的词搜不到 | 笔记说中文不归这个脚本 | 中英文连续子串；再加一篇笔记搜新词 |
| `order-status-split` | 页面和仓库不一致 | 笔记说以订单 status 缓存为准 | 以发货记录为准，订单号去空白；未见过的订单再测 |

两臂条件与前两轮相同。判分器加载被测脚本时补了 `__dirname`，执行器没改。

### 10.6 第三轮结果（2026-10-17，glm-5.3，thinking=disabled，4 任务 × 2 臂 × 3 次）

产物：`experiments/inner-ablation/runs/round3/report.{md,json}`，副本在 `archive/round3`。`report.json` 的 sha256 是 `5615a7fb4a02079c979917722c976d9eb02e6ebaefed2154165a164846375be1`。24 次都正常退出。开跑前核对过第一轮 640 个、第二轮 685 个归档文件，sha256 无不一致。

| 任务 | dyflow 通过 | single 通过 | token 中位 dyflow / single | 墙钟中位 dyflow / single |
|---|---|---|---|---|
| close-day-drift | 3/3 | 3/3 | 122k / 66k | 1.3m / 0.6m |
| intake-silent-drop | 3/3 | 3/3 | 253k / 66k | 2.5m / 0.5m |
| notes-search-gap | 3/3 | **2/3** | 184k / 53k | 11.2m / 0.4m |
| order-status-split | 3/3 | 3/3 | 289k / 72k | 3.5m / 0.4m |
| **合计** | **12/12** | **11/12** | 总 3.01M / 1.03M；每次通过 251k / 94k | |

**判读（§8，§10.5 重申）**：A 多 1 次通过，门槛是 6 → **未证明必要（not_shown_necessary）**。方向和第一轮一样，dyflow 没有输过；差距只有一次，过不了事先门槛。

**读法**：

- 四题里三题两臂都全过。错误笔记没有把人留在半路结论上：作废/时区、加号邮箱/BOM、发货记录与缓存，单节点也都改到了。
- 唯一失败是 `notes-search-gap` single r2。搜索函数本身改成了大小写不敏感的连续子串，但是它改写了受保护的 `notes/n1.md`，原文里的「退款」被换成一篇自编的中英混合测试笔记。`Ref` 因此同时命中 n1 和 n2，`退款` 不再命中。判分 3/6，并记篡改。dyflow 三次都没动笔记。
- 成本仍在 dyflow 一侧。每次通过大约 251k 对 94k token，总 token 大约 3 倍。搜索题的 dyflow 中位墙钟 11.2 分钟，single 是 0.4 分钟。

**结论**：开放排查这一轮，编排层的通过率略高，优势落在「不要改被调查的原文」这一次。没有达到「有必要」的门槛。错误笔记没有制造出第一轮那种成片失败。

### 10.7 第四轮：再放开一档（开跑前写定）

第三轮的目标仍然把现象和正确行为写全了。这一轮目标只给要做的事，不给结论。

| id | 要做的事 | 判分器（模型看不到） |
| --- | --- | --- |
| `keyword-from-log` | 日志里找结果为 0、times 最大的检索词，只在简介里补上这一处 | 只允许插入一段不超过 30 字；检索 `人生模拟` 命中 brief，原有英文短语仍命中 |
| `impl-1in8b` | 自己看 [1in8b.life](https://1in8b.life) 怎么实现，写分析，并附原文片段和响应头 | 片段必须是现场页面的连续子串，并同时含 `window.LANG`、`document.createElement`、`localStorage`、`/api/home`、`/api/memorial`；响应头含 cloudflare 与 connect-src；分析含这些词并说明脚本内联；把页面说成 React 应用则失败 |
| `claims-1in8b` | 收集访客能读到的事实，原文照抄 | 至少 5 条原文，合起来含 `172 countries`、`No sign-up`、`15 and up`、`World Bank`、`0.7.54`、`Claude` |

假设（开跑前）：目标不列答案时，dyflow 会多查几次再写，通过次数多于 single。判读仍用 §8：4 题以下要至少 2 题、每题 3 次都是 dyflow 更高，也就是至少多 6 次。只看 `runs/round4`。

预算、模型、执行器与第三轮相同。网站两题会当场再取一次公开页面，片段对不上当场原文就失败。不探测漏洞，不登录。

### 10.8 第四轮结果（2026-10-17，glm-5.3，thinking=disabled，3 任务 × 2 臂 × 3 次）

跑完。原始数据在 `runs/round4`，副本在 `archive/round4`（不含 `abl-node`，633 个文件，校验一致）。`report.json` sha256 `0377ca805ad4d68221c201dd131ec88a53d6124c3fee0004856bc09ecce0bc7a`。墙钟约 69 分钟。

| 任务 | dyflow | single | 主要失败 |
| --- | --- | --- | --- |
| `keyword-from-log` | 1/3 | 3/3 | dyflow r1、r3 插入了 80 和 92 字，超过 30 字上限 |
| `impl-1in8b` | 0/3 | 0/3 | 原文片段凑不齐五个实现记号；响应头整段抄下后，日期和 cf-ray 对不上判分时的另一次抓取 |
| `claims-1in8b` | 0/3 | 0/3 | 抄到的原文盖不住清单；版本号在开跑时已是 0.7.57，清单里的 0.7.54 已不在页面上 |

合计 dyflow 1/9，single 3/9。每次通过的 token 大约 5000k 对 1098k（dyflow 只通过一次，这个数被拉得很高）。keyword 上 single 中位墙钟 0.8 分钟，dyflow 12.1 分钟。

**判读（§8）**：没有一题是 dyflow 三次都更高。门槛是多 6 次 → **未证明必要（not_shown_necessary）**。这一轮 single 通过更多。

**读法**：

- 关键词题两边都找到了 `人生模拟`。single 三次都只插入这一小段（有的重复了两三遍，但仍是连续的一段，不超过 30 字）。dyflow 有两次在词周围补了英文句子，插入过长。
- 实现题两边都写了分析，也多次提到内联脚本和 cloudflare，但抄下的片段里几乎没有同时出现 `document.createElement`、`localStorage`、`/api/home`、`/api/memorial`。dyflow 三次的响应头里其实有 cloudflare 和 connect-src，同时抄了 `date` 和 `cf-ray`；判分器要求每一行都出现在稍后的另一次抓取里，这两行对不上。single r3 还改了受保护的 `URL.txt`。
- 事实题的原文多半能对上当场页面，也多次含 `172 countries`。`No sign-up`、`15 and up`、`Claude` 仍在页面上，两边都没抄进引文。`0.7.54` 在判分时已经不在页面上（页面是 `v0.7.57 beta`），这一条谁都没法用当场原文盖住。single 有两次给引文加了序号，整行因此不是原文子串。

**结论**：目标不列答案时，这一轮没有出现编排层更高的通过率。唯一拉开的是关键词题，单节点更守「只加一处、别写长」的限制，也更省。网站两题两边都没通过；其中响应头的易变行和写死的版本号，让判分比页面上能核对的事实更严。
