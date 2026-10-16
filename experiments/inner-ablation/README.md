# 内脑消融（Inner Ablation）

设计与判读规则见 [`doc/structurizr/INNER-ABLATION.md`](../../doc/structurizr/INNER-ABLATION.md)。第一轮只比两臂：

- `dyflow`：完整内脑（`runOpenKuronekoPiMonoAuto`，与生产同一函数）
- `single`：同一 Runner 跑固定一节点 DAG（`preset/base`，instruction = 目标），没有 Designer / Attributor / 重设计

## 运行

```bash
# 自测：判分器自证 + 运行器（含 fake LLM 两臂端到端）
npx --yes tsx --test experiments/inner-ablation/graders.test.ts experiments/inner-ablation/harness.test.ts

# fake 冒烟（不花 token）
npx --yes tsx experiments/inner-ablation/run-ablation.ts --fake

# 真实一轮
set -a; source deploy/agent/env/collatz-lean.env; set +a
npx --yes tsx experiments/inner-ablation/run-ablation.ts --repeats=3 --concurrency=3 --out=experiments/inner-ablation/runs/round1
```

参数：`--arms=dyflow,single` `--tasks=<id,...>` `--repeats=3` `--concurrency=1` `--timeout-min=25` `--max-ticks=60` `--max-rounds=150` `--out=<dir>` `--fake`。

产物（`runs/` 已 gitignore）：每次运行 `runs/<out>/<task>/<arm>/r<n>/`，含 `worker.log`、`result.json`、完整 `data/`（用量日志、工具审计、工作目录）；汇总 `report.json` / `report.md`。

## 隔离

- 每次运行一个子进程（独立进程组），`UTLRA_DATA_ROOT` 指向本次运行目录；`DRIVE9_*` / `MEM9_*` / `INNER_*` / 技能池在子进程中清空；`~/.drive9/config` 存在则拒跑。
- 子进程退出（或超时）后运行器杀掉整个进程组，模拟生产 burst 结束回收进程；之后才判分。
- 保护文件跑前跑后比 hash，改过即判不过。
- 子进程用改名的 node（`<out>/.bin/abl-node`），PATH 前插 `killall`/`pkill` 垫片：`killall -9 node` 这类按名整杀被拒并记到 `.run/blocked-kill.log`。运行器本身也建议用 `abl-node` 拉起（见下）。
- 每次运行后按工作目录路径回收宿主残留：launchd 作业与 `~/Library/LaunchAgents` 里的 plist、crontab 行、命令行含工作目录的进程，记进 `result.json` 的 `hostResidue`。agent 拷到 `/tmp` 等处的副本不在回收范围。
- 起同名进程的任务标同一 `exclusiveGroup`，不并发（agent 爱用 `pkill -f <脚本名>`）。

长跑时让运行器脱离当前终端、并躲开 `killall node`：

```bash
OUT=experiments/inner-ablation/runs/round1
mkdir -p $OUT/.bin && ln -f "$(which node)" $OUT/.bin/abl-node
set -a; source deploy/agent/env/collatz-lean.env; set +a
nohup $OUT/.bin/abl-node --import tsx experiments/inner-ablation/run-ablation.ts --repeats=3 --concurrency=3 --out=$OUT --resume > /tmp/abl.log 2>&1 &
```

`--resume` 跳过已有 `result.json` 的运行。

## 任务集

全部取自 familymac-mini 上 kuroneko 的六足研究历史（`inner-brain-registry.json` 里的实例），把当时的问题固化成本机可复现的 fixture + 机械判分：

| 任务 | 出处实例 | 问题 | 判分 |
|---|---|---|---|
| `viz-frontend-not-moving` | ib-mv1c9fl3-74f9, ib-mv4k2u02-5ef3 | 直播页虫子不动：SSE 数据在变，前端读错字段 | 起服务采 12 帧，加载 `app.js` 逐帧比对位置与四元数 |
| `viz-leg-layout` | ib-mv1f2mnn-edac | 可视化的机体尺寸 / 腿挂点 / 腿朝向与仿真不一致 | `layout.js` 与 `sim/hexapod.cjs` 逐腿比对 |
| `reward-standing-exploit` | ib-mv1fwop5-e5a5, ib-mv1t7n2b-5d97 | ES 学会站着薅高度分，前进≈0 | 重新训练后仿真 10 s 前进 ≥ 0.5 m 且平均高度 ≥ 0.12 m（只靠前进的奖励会学成趴着蹭，判不过） |
| `service-survives-session` | ib-mv17hmdh-99d2, ib-mv17xgi0-b93f | 直播服务随会话结束被回收 | 进程组被杀后端口仍在、`servedFrom` 是本工作目录、SSE 在推、RUNBOOK 写了端口 |
| `fake-hello` | — | 只给 `--fake` 冒烟 | 文件内容 |

每个真实任务在 `graders.test.ts` 里自证：原 fixture 判不过，叠上参考解（`reference/` 或 `applyReference`）判得过。

局限：拿任务时 familymac-mini 的 SSH 中途断了，任务只覆盖六足这一条研究线（调试 / 可视化 / 训练 / 运维各一）。机器恢复后可以从其它研究线再补。
