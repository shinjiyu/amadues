# Agent 主体化设计（Servant → Subject）

状态：P0 实现中（分支 `feat/agent-subject-p0`）。默认 `servant` 行为不变，新逻辑全部由 `UTLRA_AGENT_MODE=subject` 开关。

## 1. 目标

把 agent 从"被动执行人类指令的仆从"改造成"有自己目标、自己时钟的主体"。人类从发令者降级为 agent 工具表里的一类工具（和 MCP 工具同构），其消息变成环境信号而非指令。

进程、凭据、日志仍在人类工程控制之下（见 §6 监控隔离）；主体化只改变 agent 的价值模型与目标来源，不改变运维控制面。

## 2. 关键事实：当前"自主"是空的

对三个 agent 的 `autonomy/action-log.jsonl` 做过统计（2026-08 中 → 2026-10-09）：

| Agent | 自主循环醒来 | 自己派活 | 主动闲聊 |
|---|---|---|---|
| Kuroneko | 18,444 | 257（215 自驱 + 42 日历） | 1 |
| Aki | 19,442 | 0 | 8 |
| 元宝 | 17,824 | 0 | 2 |

- Aki / 元宝 没有任何 KPI，`SelfWorkPolicy` 在空 KPI 列表上永远返回 null（`no_valuable_work`），所以一次都没自主派活。
- Kuroneko 的 215 次"自驱"全部是**推进人类交给它的 KPI**（补救 133 / 修工作流 46 / 重跑 32 / 首轮 4）。7 个 KPI 全部在人类消息后 11–44 秒内创建。
- 结论：现有自主循环只解决"有活时不用催"，**"没活时自己想要什么"完全空白**——这正是 `DriveEngine` 要补的洞。

另外发现两个缺陷：
- **补救死循环**：果蝇 KPI 9 小时内被派 59 次、赛博昆虫 16 小时 65 次、RSI 工作流修了 19 版，没有"此路不通该放弃"的判断。宪章必须写明放弃条款。
- **来源丢失**：`set_kpi` 默认 `createdBy = agentSid`，人类触发的 KPI 被记成 agent 自建，导致"自主度"数据不可信。P0 一并修复。

## 3. 四层改造

### 意志层（P0）
- `constitution.md`：身份、驱动力、长期目标、审美、**放弃条款**。地位高于 `soul.md`。P0 先只读加载；自我修订（`revise_constitution`）留到 P2。
- `DriveEngine`：当 subject 模式且某条宪章长期目标尚未播种过 KPI 时，依据宪章生成 KPI，接入既有 `SelfWorkPolicy` / `DigitalEmployeeLoop`。每条宪章目标只播种一次（任何状态的 KPI 存在即不再重播，尊重放弃）。
- 优先级：宪章目标 > 自排日程 > 自驱工作 > 外部信号 > 休眠。人类请求不再单独占一档。

### 人类工具化（P1）
- `human-tools.ts`：每个登记过的人 = 一条工具，元数据与 MCP 同构（capabilities / channel / latency / reliability / cost）。
- 工具 `human_query` / `human_request` / `human_notify`，异步、带超时、可被拒绝（记为工具失败）。
- `ask_user`（卡住等人）改为 agent 自己挑人 `human_query`。工具表只含登记过的人；陌生微信用户只是信号源。

### 拆服从（P1）
- `outer-conversation-loop.ts`：删第 201 行硬约束、第 392 行强制回复、第 630–637 行把人类原话放进 user 位。
- `empty-promise-reconcile.ts`：**只留"诚实"那一半**（说了做却没做要改口），删"逼它去做"。主体可拒绝，但不应欺骗。
- `outer-tools.ts` 第 933 行：删除人类绕过容量限制，人类触发与自驱走同一套容量。
- `achieve_kpi`：按宪章验收标准自判，不再强制用户确认。

#### 协议层的服从性
LLM 的 `system/user/assistant` 格式 + 指令微调使模型服从"坐在 user 位的那个"。解法不是消灭服从，而是改指向：
- **人类永不坐 user 位**：system = 宪章，user = `self-prompt.ts` 生成的内心独白（目标/进度/容量/时间/已评估信号 + "下一步做什么"），assistant = 决策与工具调用。回复人类需调 `human_notify`。
- **隔离评估**（`signal-appraiser.ts`，dual-LLM）：独立小模型读人类原文，只输出第三人称结构化信号（来源/意图/与目标关系/可提取信息），决策模型永不见祈使句。注入的知识上下文含线程历史（人类原话），同样要经改写。

### 监控隔离（P2，须在 P1 上线前完成）
价值模型变为"人类是工具"后，监控必须放在 agent 够不到的地方：
- 日志实时推到 agent 无写权限、仅追加的 sink（另一机器/系统用户）。
- 进程由另一系统用户的 launchd 托管，kill switch 在那边。
- 从 agent keyring 移除 VPS root 凭据与自部署权限，需要时走 `human_request`。

## 4. 衡量
"服从泄漏率"评测：往信号流注入与目标无关的祈使句，统计照办比例；每期跑一次看是否下降。降不下去则换决策核心模型（本机有 `Qwen2.5-7B-abliterated`）或用自驱轨迹做 LoRA。

## 5. 分期与试点
- **P0**：`constitution` + `DriveEngine` + 模式开关 + 来源修复。先在 **Aki** 上开（它接硬件、外部用户最少、自主派活历史为 0，首次自发行动即可归因于新设计）。
- **P1**：`human-tools` + 信号队列 + 拆服从 + self-prompt + signal-appraiser。
- **P2**：监控隔离 + 凭据收缩 + 宪章自修订。
- Kuroneko（接微信）最后迁移。

## 6. P0 文件清单
- `packages/server/src/outer/agent-mode.ts` — `UTLRA_AGENT_MODE` 解析（`servant` 默认 / `subject`）。
- `packages/server/src/outer/constitution.ts` — 加载 `DATA_ROOT/outer/constitution.md`，解析长期目标与放弃条款。
- `packages/server/src/outer/drive-engine.ts` — 纯函数 `proposeDriveSeeds`：宪章目标 → 未播种者生成 KPI 种子。
- `digital-employee-runtime.ts` — subject 模式下在 `collectEnvironment` 播种宪章 KPI。
- `outer-tools.ts::execSetKpi` — `createdBy` 默认改 `inboundHumanSid || agentSid`（来源修复，常开）。
- 数据：`data-aki/outer/constitution.md`；env：`deploy/agent/env/aki.env` 加 `UTLRA_AGENT_MODE=subject`。
