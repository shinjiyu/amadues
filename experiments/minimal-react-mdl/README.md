# 最小 ReAct + 工具 MDL 自生长 · P2 实验

ADL：[`doc/structurizr/TOOL-MDL-GROWTH.md`](../../doc/structurizr/TOOL-MDL-GROWTH.md)（结论记在 §11）

检验**一个**命题：在有复发结构的确定性任务流上，每任务 token 成本是否随时间单调
下降，且下降是否来自系统自己创建的工具。

## 跑

```bash
# 离线冒烟：不需要 API key，验证接线（脚本化 agent，不造工具 ⇒ 成本应当持平）
npx --yes tsx experiments/minimal-react-mdl/run-loop.ts --fake --batches=2 --tasks=4

# 真实 LLM（默认 3 种子重复 —— 单跑的批间方差远大于效应，读不出趋势）
set -a && source deploy/agent/env/collatz-lean.env && set +a
npx --yes tsx experiments/minimal-react-mdl/run-loop.ts --repeats=3 --batches=4 --tasks=6

# §11.14 析因：显式打开观测上限告知（默认关 —— 打开会单独把库打死）
npx --yes tsx experiments/minimal-react-mdl/run-loop.ts --obs-limit-notice --repeats=3

# 对照臂 A（M11）：把 create_tool 放进内循环交给模型判断，理论预测产出 ≈0
npx --yes tsx experiments/minimal-react-mdl/run-loop.ts --arm=a --repeats=3 --batches=4

# staged 探针（§11.22）：先看跨任务子序列能否被挖到。fake 只验证接线；真实模型才是探针本身
npx --yes tsx experiments/minimal-react-mdl/run-loop.ts --family=staged --fake --batches=2 --tasks=6 --outdir=.run-staged

# DeepSWE 原题（§11.23）：不走 Pier。借用题面，跑本仓库的 shell 循环
npx --yes tsx experiments/minimal-react-mdl/run-deepswe.ts --n=4 --budget=30
```

`--keep-rejected` 保留被拒候选的函数体与夹具到 `.run/rejected-*/`，便于分辨
「工具写错了」还是「闸门过严」。产物与报告在 `.run/`（已 gitignore）。

## A/B 对照（同一任务族、同三种子）

| 臂 | create_tool | 库中工具 | 学到的工具被调用 | 完整正例 |
|----|-------------|---------|----------------|---------|
| **A**（内联判断） | **0 / 72 任务** | 0 | 0 | 无 |
| **B**（离线挖掘） | n/a | 1/3 种子收到 | 6/6 任务全调用 | 种子 4242 |

相对结论对方差不敏感：臂 A 在 72 个任务上一次都没想过造工具。这与 dyflow T0 的生产
零注册一致，也是 ADL M11 的预测。接线不是稻草人——`create_tool` 签名含 `args`，
形式合法性仍检查；重放闸门的缺席是内在的（前瞻造工具时还没有历史实例）。

## 任务族

`--family=reports`（默认）、`--family=schema`、`--family=staged`。schema 族是已记录的
**零产出正确判决**，reports 族满足「中间观测占主导」但轨迹常被一行流折短。
staged 探针用执行器回滚禁止一步写完 `out.csv`，只回答「会不会出现可挖的重复子序列」，
不在候选出现之前比较 token。

| 族 | 大观测在哪 | 机制的正确行为 |
|----|-----------|---------------|
| `schema` | 获取步（必须读的 schema） | **什么都不建**——没有可压缩的东西 |
| `reports` | 中间步（翻阅后被筛掉的报告） | 可以建；实测收录出 `cat_grep_truncate` |
| `staged` | 分步中间文件（s1 再 s2） | 先问候选是否出现；一步写完会被回滚 |

### reports 族怎么迫使模型真的读

报告里的延迟数字写成**英文单词**（`four hundred twenty milliseconds`）。awk/sort 做不了
词形数字的算术比较，模型必须逐份读；读完只留下「超没超阈值」一个判断，报告正文
就作废了 ⇒ `obsKind` 判为 `intermediate` ⇒ 这部分才是工具能吞掉的。
能压缩的是机械那半截（把 40 行样板里那一句捞出来，330 → ~12 token），
词形换算仍留给模型——工具不替代判断，只替代搬运。

### schema 族

`tasks.ts` 生成 `data/logs-K.tsv`（TSV、**无表头**）+ `data/schema-K.txt`。
列序每个文件都不同，只记录在那份啰嗦的 schema 里，所以「读 schema」是**真的必要**
而非摆设。任务：按 level 过滤、取 service 列、排序写入 `out.csv`、自检行数。
验收是逐字比对 `out.csv`。

满足 ADL §9 三条前置：

| 前置 | 落实 |
|------|------|
| 确定性 | `verifyTask` 逐字比对产物 |
| 复发结构 | 每个任务共享 `读 schema → 过滤投影 → 自检` 骨架，只有参数变 |
| 成本可计量 | schema 观测刻意写得贵：实测观测占总成本 94%（1656 vs 109 动作 token） |
| ⚠️ 中间观测占主导 | **不满足**。贵的那部分是 schema，而 schema 是获取步——不可压缩。见下 |

## 结果 · reports 族（glm-5.3，3 种子 × 4 批 × 6 任务，min-gain 12）

| 种子 | 批 2（无工具） | 批 3 | 结果 |
|------|---------------|------|------|
| 4242 | 1111，6/6 | **798，6/6，toolCalls=6** | 收录 `scan_latency_reports`，每个任务都调用 |
| 4249 | 1263，5/6 | 1152，5/6，toolCalls=0 | 无候选过闸，成本平 |
| 4256 | 1068，5/6 | 1407，3/6，toolCalls=0 | 无候选过闸，成本平 |

种子 4242 是机制**第一次完整成立**的实例：同一任务集内，工具收录 → 6/6 任务全部调用
→ obs/已解降 28% → 正确率不降。因果结构是对的，另两个种子什么都没收录、成本就平着，
正好是天然对照。

**但 n=1，聚合读不出趋势**（效应 195，最大批内离散 5127）。离散主来源是正确率波动
（有一批只解出 1/6，obs/已解冲到 6091）。**正确率方差是当前测量的约束瓶颈，不是机制。**

### 两件必要的仪表

`toolCalls` — 学到的工具被实际调用的次数。缺这一列时成本曲线不可信：早先一次跑里
工具收录后批 2 调 1 次、批 3 调 0 次，那 13.6% 的"下降"与机制毫无关系。

`obsPerSolved` — 按已解任务归一。失败的任务往往更短，不归一会把正确率波动读成成本
下降。驱动器在「效应 < 批内离散」或「工具零调用」时会直接打印警告。

### min-gain 是「接受率 ↔ 实际复用」的旋钮

| min-gain | 收录 | 实际调用 |
|----------|------|---------|
| 4 | 每批都收 | **≤1 次**（ADL §8 命中「阈值太松」） |
| 12（现默认） | 3 种子里只有 1 个收到 | **6/6 任务全调用** |

两侧都量到了。模型一行流化使挖出的实例只有 2–3 个符号，`gainOf = (support−1)×length`
常常够不到 12，这是接受率低的直接原因。

### 降难度 / 观测上限告知 —— 别这么调

§11.14 的 2×2（同三种子）：

| | 告知关 | 告知开 |
|---|---|---|
| per-task=4 | 1/3 种子完整正例（§11.9） | **3/3 零收录** |
| per-task=3 | **3/3 零收录** | 3/3 零收录（§11.12） |

任一因子单独就够打死。默认：`per-task=4`，观测上限告知关（`--obs-limit-notice` 才开）。

### 一个与机制无关但会污染实验的观察

模型会用 glob 把 24 份报告一次性 `cat` 出来，然后在**被截断**的观测上猜答案，正确率
因此在 3/6 与 6/6 之间跳。「一行流 + 截断」是真实 agent 的一种失败模式。

## 结果 · schema 族（glm-5.3，6 任务 × 4 批）

**M12 修复前**：机制跑通但核心预测被证伪，成本反向上升 12 → 18 步、观测 2525 → 4331
token，正确率不变 6/6。

**M12 修复后**：误收消失，成本持平（12 步 / ~2.5k 观测 token，四批一致），
accept→retire→accept 的 churn 消失，正确率不变。但**库全程为空**。

库为空是正确判决，而且它比「成本下降」更有信息量：这个任务族里唯一的复发片段是
`cat schema → awk`，其中 `cat schema` 是获取步（409 token，agent 必须看到，封进工具
也省不掉），`awk` 那步的观测只有 5 token。真正可省的不过 ~5 观测 + ~30 动作 token，
付不起 37 token/步 的 manifest 携带成本。

> 真实模型两步就把任务做完了，贵的那部分是**不可约的信息获取**。这种任务上没有任何
> 工具能帮忙——不是机制不行，是没有可压缩的东西。

所以本任务族**无法检验正面命题**。要检验，得改成 agent 必须翻阅大批中间结果、看完
即弃的形态（多轮检索/筛选），而不是读一份很贵的 schema。

## 四个已修的坑

**闸门曾经是自指的**（ADL M5a/M5b）。第一版夹具的期望值是拿候选工具自己跑出来的，
闸门恒过，一个 awk 列引用写错的工具被收录、上线即失败、模型退回原始 shell。改成
**效果等价**（比对产物摘要，期望值由原始实例独立重跑推导）后立刻拦住了同一类错误。
这一条支持 ADL 的核心论断：收录判据必须机械，模型判断会放过看似合理的错误泛化。

**反合一需要闸门反馈的修复环**。首发泛化不可靠（模型把列号绑成字符串 `"$2"`，awk 里
`$m` 强转为 0、静默退化成整行比较），把失配信息喂回去一轮即通过。不接这个环，
机制产出恒为零。

**账本视界要与 support 同口径**。`carry = manifestCost × remainingSteps` 里的
`remainingSteps` 若传预算上限，携带成本高估数倍，好工具被误拒。正确取值是
「下一批预期步数 ≈ 刚跑完这批的实际步数」。

**`obsTokens` 曾记截断前的量**（ADL M10 / §11.8）。模型 `cat reports/rep-*.txt` 产出
31k 字符、截断到 4k 才进上下文，trace 却记下 7854 token，其中七分之六从未进过上下文。
`savedTokensPerUse` 吃这个字段，于是把从未付过的成本算成可省。M10 记的是**上下文
成本**，不是执行器产出量；`createTraceRecord` 现在按 `shownObservation` 计数，
`obsDigest` 仍按完整观测算。

## 沙箱注意

重放的隔离沙箱会软链 workDir 下除 `runs/` 与产物之外的一切。早先只链了 `data/` 和
`tools/`，于是 reports 族的原始命令在沙箱里直接失败、期望值取不到，所有候选都被误报为
`antiunify_empty`——加新任务族时别忘了语料目录。

## 与 ADL 的对应

| 文件 | 角色 |
|------|------|
| `tasks.ts` | 合成任务族 + 确定性验收 |
| `ports.ts` | shell 执行器、Zhipu 内循环端口、反合一端口（含闸门反馈修复环）、效果等价重放 runner |
| `run-loop.ts` | 批次驱动、成本分项记账（M10）、生长周期编排、归因报告（M9） |

内核（`reactKernel`）与外循环（`growthCycle`）都来自 `packages/server`，本目录只提供
端口实现。换模型、换执行器都不触碰内核——这是 M1 的实际含义。
