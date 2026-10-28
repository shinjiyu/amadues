# Pi-mono 结构，以及和 mini-swe-agent 的对照

范围：本仓库 `packages/server/src/pi-mono/`。对照对象是 [mini-swe-agent](https://mini-swe-agent.com/latest/)（SWE-agent 团队的默认 agent，约百行控制流）。

先把边界说清楚：**pi-mono 不是一条 agent 循环。** 它是内脑的进程宿主和 tick 调度。它每次 `tick()` 叫 DyFlow 控制器走一个宏步。和 mini-swe-agent 同一类的东西，是 DyFlow 里 baseNode 的 ReAct，或消融用的单节点基线，不是这个目录本身。

`@earendil-works/pi-ai` 1.4 被 exec-agent 和玩耍循环使用。玩耍循环的控制流是 `@earendil-works/pi-agent-core` 的 `Agent`（`play-loop.ts`），模型调用仍走内脑的 LLM 适配器。DyFlow 那条 tick 不经过这两个包。

---

## 1. 目录里每个文件做什么

| 文件 | 角色 |
|------|------|
| `inner-brain-spawner.ts` | 外脑用的启动器。`spawn` 一个 Node 子进程，传入环境变量，转发 stdout/stderr，退出时回调 |
| `inner-brain-worker.ts` | 子进程入口（`npm run inner-brain`）。校验 env，写状态文件，调用 Auto |
| `run-tick.ts` | 调度。建一个 DyFlow 控制器，单次 `tick()` 或循环到停。`INNER_PLAY_MODE` 时改走 `play-loop.ts`。进程内串行锁、停信号 |
| `play-loop.ts` | 玩耍模式。`@earendil-works/pi-agent-core` 的 `Agent` 跑工具循环，不经过 Designer |
| `inner-runtime.ts` | 给控制器装配 LLM、工具表、日志、技能、drive9、计划检索 |
| `run-single-node.ts` | 消融入口。同一套 runtime，不走 Designer，只跑一个 `preset/base` |
| `brain-snapshot.ts` | Dashboard 只读。解释「一次 tick 是什么」，并 tail 日志拼检查视图 |
| `tail-file.ts` | 从 `.run/pi-mono/logs/*.jsonl` 尾部读最后 N 行，避免整文件进内存 |

外脑调用点：`outer/outer-tools.ts` 的 `set_goal` 里 `spawnInnerBrainWorker`。停、状态、推送在 `stop-inner-brain.ts`、`push-loop.ts`、`list-inner-brain-instances.ts`。

---

## 2. 进程结构

```text
外脑进程
  set_goal
    spawnInnerBrainWorker()          inner-brain-spawner.ts
      node [--import tsx] inner-brain-worker.ts
        env: INNER_INSTANCE_ID, INNER_WORKSPACE_ID, INNER_WORK_DIR, INNER_MAX_TICKS
        │
        runOpenKuronekoPiMonoAuto()   run-tick.ts
          createInnerRuntime()        inner-runtime.ts
          createDyflowController()    openkuroneko/inner-brain/controller.ts
          while ticks < maxTicks:
            controller.tick()         一个宏步
            写 .run/inner-worker-status.json
```

子进程 cwd 固定为可写的 `workDir`。标准输出带 `[ib:实例后八位]` 打回父进程。`set_goal` 拿到 pid 就返回，不等循环结束。

必须的环境变量：`INNER_INSTANCE_ID`、`INNER_WORKSPACE_ID`、`INNER_WORK_DIR`。缺任一则退出码 2。`INNER_MAX_TICKS` 默认 500。可选：`INNER_KPI_ID`、`INNER_PEER_WORKSPACE_IDS`、`INNER_WORKSPACES_ROOT`。

退出码：0 正常（idle / max_ticks / stop_signal），1 运行时错误，2 参数错误。

状态文件：`<workDir>/.run/inner-worker-status.json`  
`phase` 为 `starting | running | done | error`，另有 `ticks`、`lastTickAt`、`stoppedBy`。

---

## 3. 调度：一次 tick 有多大

`run-tick.ts` 文件头写明两档：

- `runOpenKuronekoPiMonoTick`：新建控制器，调用 **一次** `tick()`。
- `runOpenKuronekoPiMonoAuto`：同一个控制器上连续 `tick()`。

Auto 的停：

| `stoppedBy` | 条件 |
|-------------|------|
| `idle` | 这次 `tick()` 返回 `hadWork === false` |
| `max_ticks` | 达到上限（传入值夹在 1～10000，默认 500） |
| `stop_signal` | 工作目录里出现 `.stop-signal`（`writeStopSignal`） |

`withPiMonoLock` 把同一进程里的 Auto/Tick 串成一条 Promise 链，避免两段循环叠在一起。

`brain-snapshot.ts` 里的 `PI_MONO_TICK_EXPLAINED` 定义了粒度：一次 Pi-mono 单步 = `Controller.tick()` 恰好一次。它按 `.brain/dyflow-state.json` 的 mode 把 **一整段** DESIGN 或 RUN 跑完。不是一次模型调用，也不是一个工具调用。RUN 这段宏步内部已经包含多轮 LLM 和工具。

控制器在 `openkuroneko/inner-brain/controller.ts`，不在 pi-mono 目录里。pi-mono 只负责把它建出来并按 tick 推。

mode 转移（以控制器为准）：

```text
DESIGN     出图 → RUN；自报完成 → DONE；连续空转 3 次 → ERROR
RUN        整图跑完 → ATTRIBUTE（无论成败）
ATTRIBUTE  有未完成 pending → AWAITING（hadWork=false，Auto 因此 idle 退出）
           否则 → DESIGN
AWAITING   等到了 → DESIGN；还在等 → hadWork=false
DONE / ERROR / STOPPED → hadWork=false
```

所以「pi-mono 的循环」在结构上是：**外层 tick 计数器 + 内层四段状态机**。外层不理解任务，只看 `hadWork`。

---

## 4. 运行时装配（inner-runtime）

`createInnerRuntime({ workspaceId, workDir })` 在第一次 tick 前做完这些事：

1. 建 `<workDir>/.run/pi-mono/`，写入 `agent.config.json`（`agentPath`、`utlraWorkspaceId`）。
2. 注册文件型 input/output：`.run/pi-mono/input`、`.run/pi-mono/output`。完成时控制器往 output 写 `{ type: 'COMPLETE', ... }`。
3. 把工具的工作目录守卫设到本 `workDir`，可选挂上 peer workspace 只读。
4. 建 LLM：优先内脑专用 env；否则 OpenAI 兼容适配器，默认 base `open.bigmodel.cn`，`toolWireFormat: 'minimal'`。
5. 技能：有 drive9 用 `Drive9SkillProvider`，否则本地技能池。
6. 工具表一次注册（见下节）。
7. 有 drive9 时再挂节点定义库和事实同步。计划检索走 `createPlanReferencePort`。

消融 `runSingleNodeBaselineInWorkDir` 复用这份 runtime，然后调用 `runSingleNodeBaseline`：固定一张只有 `preset/base` 的图，instruction 等于 goal。没有 Designer，没有 Attributor，没有重画。

---

## 5. 工具表（pi-mono 装上、baseNode 使用）

`inner-runtime.ts` 的 `createToolRegistry` 注册：

- 文件：`read_file` / `write_file` / `edit_file` / `search_files`，以及 peer 工作区只读
- Shell：`shell_exec`、探测、后台执行、读输出、杀掉
- 浏览器：打开、动作、关闭、列表、连跑步骤
- 其它：识图、网页搜索、时间、`run_agent`、能力缺口、技能查询、`register_deliverable`
- 等待：`ask_user`、`wait_timer`、`wait_signal`
- 自更新：读计划、校验、回滚
- 代理管理：列出、停止

这些是 **函数调用工具**（适配器走 tool wire），不是「模型输出一段 bash 再由环境解析」。

---

## 6. 磁盘

```text
<workDir>/
  .brain/dyflow-state.json      当前 mode（控制器读写，pi-mono 不解析）
  .brain/memory.json            facts、失败、节点结果
  .brain/local_dag.json         当前图
  .brain/pendings.json          等待
  .run/inner-worker-status.json pi-mono 自己写的存活状态
  .run/pi-mono/agent.config.json
  .run/pi-mono/input
  .run/pi-mono/output           COMPLETE 等事件
  .run/pi-mono/logs/*.jsonl     tail-file 读这里
  .stop-signal
```

日志检查：`tail-file.ts` 从文件尾按 64KB 回读，默认给检查器最后 800 行。优先当天 `YYYY-MM-DD.jsonl`。

---

## 7. mini-swe-agent 的结构（对照用）

官方描述（v2，[control flow](https://mini-swe-agent.com/latest/advanced/control_flow/)）：

```text
Agent.run(task)
  初始化 messages（system 模板 + instance 模板）
  loop:
    step() = query() 然后 execute_actions()
    query: 检查步数/费用 → Model.query(messages) → 追加模型回复
    execute_actions: 从回复里取出动作 → Environment.execute → 格式化观察 → 追加
    直到最后一条消息 role == exit
```

结束不用返回值，用继承 `InterruptAgentFlow` 的异常，异常上带着要追加的消息：

| 异常 | 何时 |
|------|------|
| `Submitted` | 命令输出第一行是 `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` |
| `LimitsExceeded` | 步数或费用到顶 |
| `FormatError` | 模型输出不符合约定格式 |
| `UserInterruption` | 人打断 |

结构上的几条硬选择：

- **只有 bash。** 不用模型的 tool-calling 接口。动作是回复里的 bash 代码块。
- **历史是一条线。** 每步只追加消息。 trajectory 和送给模型的 messages 是同一份。
- **每次动作新进程。** `subprocess.run`（或等价的 `docker exec`），不保留 shell 会话。换沙箱就是换 `Environment.execute`。
- **环境可换：** 本机、docker/podman、singularity、bubblewrap 等。
- **模型可换：** litellm 等。agent 代码不绑一家 API。

---

## 8. 对照

| | pi-mono（本仓库） | mini-swe-agent |
|--|-------------------|----------------|
| 它是什么 | 进程宿主 + tick 调度。循环在 DyFlow 控制器 | 代理本身。`run` / `step` 就是全部控制流 |
| 一步 | 一个宏步：整段 DESIGN，或整段 RUN（RUN 内含多轮工具） | 一次模型回复 + 执行其中的 bash |
| 停 | `hadWork=false`、tick 上限、`.stop-signal`、进程退出码 | 消息 `role=exit`，由 Submitted / 限额 / 格式 / 人打断异常写入 |
| 完成判定 | Designer 自报完成，或图跑完后归因再规划 | 模型在 bash 里打出提交魔串 |
| 工具 | 一大张函数调用工具（文件、shell、浏览器、等待、交付登记） | 只有 bash，无 tool-calling |
| 历史 | 拆在 `.brain` 的 state、memory、dag、run-context；ReAct 消息只活在单个节点内部 | 一份线性 messages，全程追加 |
| Shell | 有前台 exec，也有后台 shell（可读输出、可杀） | 每次 `subprocess.run`，动作之间无会话 |
| 沙箱 | 子进程的 cwd = 工作台目录。隔离靠进程，不靠可替换 Environment | Environment 接口，本地与容器同一条执行路径 |
| 模型接入 | 内脑 OpenAI 兼容适配器，写死在 `createInnerRuntime` | Model 接口，litellm 等外挂 |
| 谁派活 | 外脑 `set_goal` 起进程后不再推循环 | `Agent.run(task)` 自己跑到 exit |
| 新输入 | 进程已在跑时，不把新句子插进当前 messages。等待走 pending，新任务新进程 | `UserInterruption` 把消息加进同一条历史再继续 |
| 代码量级 | 宿主约千行，加上 DyFlow / 工具表是一整棵内脑 | agent 约百行，加环境与模型再约百行 |

同一类循环若要在本仓库里找：`run-single-node.ts` 加 baseNode ReAct，形态上最接近 mini-swe-agent（一个目标、一轮工具循环、做到完或到轮次上限）。即便如此仍有差别：它用函数调用和多工具，历史不保证等于轨迹全文，完成也不靠魔串。

exec-agent（`exec-agent/loop.ts`）更接近「单循环 + shell」，但它用 pi-ai 的 tool call、有 reflect 写 rule/skill、用 JEV 判完成，并且 **不属于 pi-mono**。

---

## 9. 阅读顺序

1. `inner-brain-spawner.ts` — 进程边界  
2. `inner-brain-worker.ts` — 状态文件与退出码  
3. `run-tick.ts` — tick 与三种停  
4. `inner-runtime.ts` — 工具与模型从哪来  
5. `openkuroneko/inner-brain/controller.ts` — 宏步里面的 mode  
6. mini-swe-agent：`src/minisweagent/agents/default.py` 与 [control flow](https://mini-swe-agent.com/latest/advanced/control_flow/)
