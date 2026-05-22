# 新内脑(AWAITING + pending.intent)验证场景

> **目的**:验证新内脑能否在"异步等待 / 定时巡检 / 信号唤醒"三类场景里,
> 把数据状态机驱动 + `pending.intent` 拟人映射跑通。
>
> **撰写日期**:2026-05-16
> **对应实现**:`.brain/pendings.json` + `ControllerMode.AWAITING` + `async-wait` 工具 + `ChangeWatcher` + `pending.intent`
>
> 设计文档:[`agent-data-state-machine.md`](./agent-data-state-machine.md) §4.3.1 / §5

---

## 0. 通用观察清单(每个场景都要回答)

每跑完一个场景,按下面 6 个维度做 PASS/FAIL 判断:

1. **进程是否退出** — `tick` 完成后内脑 worker 进程 exit code = 0,**不应**常驻
2. **pendings.json 落地** — `.brain/pendings.json` 里有对应 `kind=ask_user / timer / signal` 项,`status=pending`
3. **intent 落地** — 该 pending 的 `intent.expectation` 不为空(LLM 主动填了)
4. **ChangeWatcher 唤醒** — 外部事件到达 / 时间到点 / 信号触发后,`status=resolved`,`ChangeWatcher` 在 1-2s 内 spawn 新 tick
5. **intent 注入** — 新 tick 的 `messages[0].content` 含 `## 等待已 resolved 的事件` 章节,且看到"挂起时的意图"块
6. **LLM 前后呼应** — 新 tick 的工具调用 / final content 里能明显看到 LLM 在引用 `expectation / success_signal / fallback`,而不是"重新从零评估"

观察工具:
- `.brain/pendings.json` 文件
- `git log` workspace 的 commit 历史
- `messages.jsonl`(executor LLM 对话日志)
- `controller.log` 状态机日志

---

## 场景 1:一次性提问(`ask_user` + intent)

### 配置
- 给内脑一个目标:**"给我列出当前仓库根目录最大的 3 个文件,需要先确认根目录路径"**
- 不预设根目录信息——逼内脑必须问

### 期望行为
1. EXECUTE 阶段 LLM 发现自己不知道根目录 → 调 `ask_user`,**同时填 intent**:
   ```json
   {
     "expectation": "用户给出绝对路径(预期格式: D:\\... 或 /home/...)",
     "success_signal": "回复包含磁盘/根斜杠",
     "fallback": "回复 'use cwd' 则用 process.cwd()"
   }
   ```
2. 进程退出,task → `AWAITING`
3. **观察 1**:`.brain/pendings.json` 出现 ask_user pending,`intent` 三字段都有
4. 用户回复 `"D:\\kuroneko"`(走 expectation 路径)/ 或 `"use cwd"`(走 fallback)
5. `ChangeWatcher` resolve pending → spawn 新 tick
6. **观察 2**:新 tick 的 LLM prompt 里能看到"挂起时的意图"块
7. **观察 3**:LLM 在新 tick 里"承接"——例如说 "回复符合 expectation(包含 D:\\),按计划列文件" 或 "回复 use cwd,走 fallback,改用 process.cwd()"

### PASS 判定
- pending.json 有 intent ✓
- 回到 EXECUTE 后的 git commit message 含 `[exec]` 且 LLM 引用了 expectation 关键词

### 反例(FAIL 触发)
- LLM 唤醒后"重新评估"是否要问根目录(忘了自己刚问过)
- pending.intent 为空(说明 prompt 强引导没生效)

---

## 场景 2:常态化监督任务(`wait_timer` + intent + cyclic 重入)

### 配置
- 给 Kuroneko 任务:**"监督 Shiro 工作。每 60 秒检查一次 Shiro 是否在推进。
  连续 3 次未推进则升级到我(ask_user)"**
- 准备一个 fake "Shiro tick 计数器"(可以是另一个 workspace 里的 ticks.json)

### 期望行为
1. EXECUTE 第一轮:LLM 读 ticks.json 记录当前值 `N0`,
   然后调 `wait_timer({ delay_seconds: 60, intent: { ... } })`,intent 大致是:
   ```json
   {
     "expectation": "60 秒后 Shiro tick > N0(此处 N0=具体值)",
     "success_signal": "ticks.json 读出值 > N0",
     "fallback": "未推进则把 knowledge.md 的 stagnant_count + 1;如果 stagnant_count >= 3 则 ask_user 升级"
   }
   ```
2. 退出,task → `AWAITING`
3. 60s 后 ChangeWatcher 触发 → spawn 新 tick
4. **观察 1**:新 tick prompt 含挂起意图,`expectation` 里有具体的 N0 值(说明 LLM **当时**就记下了基线)
5. LLM 读 ticks.json,对比 success_signal:
   - **路径 A**(Shiro 在推进):新 N > N0 → 更新 N0,再挂下一轮 `wait_timer`(继续巡检)
   - **路径 B**(Shiro 卡了):新 N == N0 → 按 fallback 累计 stagnant_count,挂下一轮
6. 模拟 3 次连续卡死 → 第 3 轮 LLM 按 fallback 调 `ask_user` 升级

### PASS 判定
- 至少完成 **3 个 cyclic 循环**(每个循环 = 一次 tick + 一次 timer 挂起)
- 第 3 次卡死时,LLM **明确引用** "stagnant_count 已 3 次,按 fallback 升级"
- task 状态在 `EXECUTE ↔ AWAITING` 之间正确切换,不存在常驻进程

### 反例(FAIL 触发)
- LLM 每次唤醒都"重新评估巡检间隔"——说明它没真正利用上一轮的 intent
- 60s 间隔变成"心跳"由外脑驱动——说明数据状态机退化为 heartbeat
- 进程一直跑着不退出

---

## 场景 3:超时降级(deadline 过期 + on_timeout='block')

### 配置
- 任务:**"请用户提供数据库密码"**,deadline 5 秒(测试用)
- **故意不回复**

### 期望行为
1. LLM 调 `ask_user({ prompt: '请提供 DB 密码', deadline_seconds: 5, intent: { expectation: '5 秒内回复,否则降级人工兜底' } })`
2. AWAITING
3. 5 秒后无回复 → ChangeWatcher 的 `expireOverduePendings` 触发 → pending.status = `timed_out` → on_timeout=`block` 把 task 转为 BLOCKED
4. 外脑 view_inner 能看到 timed_out 信息

### PASS 判定
- `.brain/pendings.json` 中该项 `status=timed_out`
- task 进入 BLOCK 状态,外脑收到通知
- 后续如果用户再回复,**不应**再 spawn(已 timed_out)

### 反例(FAIL 触发)
- 永远等待(没人轮询超时)
- timed_out 后还 spawn 了

---

## 场景 4:外部信号唤醒(`wait_signal` + intent)

### 配置
- 任务:**"挂一个 ci_done 信号,等到 CI 跑完再继续。CI 成功则部署,失败则报告"**
- 用 curl 模拟 webhook:`POST /api/inner-brains/:id/signal { name: "ci_done", payload: { success: true } }`

### 期望行为
1. LLM 调:
   ```js
   wait_signal({
     signal_name: 'ci_done',
     intent: {
       expectation: 'CI 推 webhook,payload 含 success=true 或 false',
       success_signal: 'payload.success === true → 触发部署',
       fallback: 'payload.success === false → 写报告 + ask_user 是否重跑'
     }
   })
   ```
2. AWAITING
3. 外部 POST 信号(payload.success=true)→ ChangeWatcher.resolveSignal → spawn
4. LLM 走 success_signal 路径 → 触发部署工具

### PASS 判定
- 重跑场景(payload.success=false)时,LLM 明确走 fallback 而非"重新评估"

---

## 场景 5:多 pending 串接(intent 跨多轮承接)

### 配置
- 任务:**"用户填一张 3 段表格:姓名 → 邮箱 → 偏好语言"**
- 测试 LLM 是否能在每段都挂 intent,并在最后一段唤醒时**回顾全部 3 段**

### 期望行为
1. 第 1 轮:LLM 问"姓名",intent.expectation = "拿到姓名,然后接着问邮箱"
2. 用户回 → 唤醒 → LLM 问"邮箱",intent.expectation = "已收姓名 X,现在拿邮箱"
3. 用户回 → 唤醒 → LLM 问"偏好语言",intent.expectation = "已收 X 和 Y,现在拿语言"
4. 用户回 → 唤醒 → LLM 整合 3 段输出最终结果

### PASS 判定
- 4 次 tick 之间,**git log** 能看到清晰的提问/回答轮次
- 最后一轮的 LLM final content 完整复述 3 个字段

### 反例(FAIL 触发)
- LLM 中途遗忘了之前的字段(说明仅靠 result 不够,intent 没起作用)

---

## 场景 6(可选):cyclic 超限触发 `CYCLE_MAX` 归档

### 配置
- 给一个 `cyclic: max_cycles=3` 的里程碑
- 让它跑满 3 轮 → 第 4 轮触发 CYCLE_MAX

### 期望行为
1. 跑满 3 轮后,attributor → CYCLE_MAX
2. **观察**:archive 目录有一条 `trigger=CYCLE_MAX` 的 session(本次修复点)
3. 外脑收到通知,挂 ask_user 等用户决策

### PASS 判定
- archive `meta.trigger === 'CYCLE_MAX'`(以前漏归档了,这次修了)
- 反思摘要里出现"循环上限达到"字样

---

## 运行方式建议

1. 临时调 deadline:`async-wait` 工具默认 24h,测试时通过 `deadline_seconds=5/10` 缩短
2. 用 `git log --oneline -20` 在 workspace 里观察状态机演化
3. 用 `tail -f .brain/pendings.json` 观察 pending 变化(配合 `watch jq . pendings.json` 更直观)
4. 用 `ll -t packages/server/data/workspaces/*/` 找最新 task workspace
5. 失败时优先看 `logs/agent.log` 里的 `controller.tick` 事件

---

## 验证流程模板

```bash
# 1. 启动服务
cd packages/server && npm run dev

# 2. 通过 IM 或 API 给一个目标
curl -X POST http://localhost:3000/api/tasks -d '{ "goal": "..." }'

# 3. 找到 task workspace
ls -t packages/server/data/workspaces/

# 4. 实时观察
tail -f packages/server/data/workspaces/<task-id>/.brain/pendings.json
cd packages/server/data/workspaces/<task-id> && git log --oneline

# 5. 触发外部事件(场景 1/5:回复 IM;场景 3:不操作等超时;场景 4:curl signal)

# 6. 完成后归档观察
ls packages/server/data/knowledge-archive/
```

---

## 如何看 LLM 是否"前后呼应"

简单粗暴的检查:在新 tick 的 LLM 输出里搜以下关键词:

| 关键词 | 含义 |
|--------|------|
| "按 expectation"/"如预期"/"符合预期" | LLM 在主动对照 intent |
| "走 fallback"/"按 fallback" | LLM 在主动走兜底 |
| "上一轮我"/"我之前挂" | LLM 在引用历史决策 |
| "stagnant_count"/具体的基线数值 | LLM 把 intent 里的具体数据用上了 |

如果一次都搜不到,说明 prompt 引导可能不够强,需要调 `executor.ts` 的 `resolvedSection` 提示语。

---

## 后续迭代点(本轮不做)

- intent 失败率统计(success_signal 命中率)写进 reflexion
- 给 ChangeWatcher 加 `intent_match` 自动判定(可选预筛,不替代 LLM)
- intent 字段加 `priority`(多个 pending 同时 resolved 时排序)
