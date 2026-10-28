# 最小 exec agent

基础 agent，不是 [`TOOL-MDL-GROWTH.md`](./TOOL-MDL-GROWTH.md) 里的冻结 `reactKernel`。后者为 token 账截断历史；本组件把完整消息留给模型。

## 循环

1. 消息从一条 user（任务）开始。
2. 用 `@earendil-works/pi-ai`（1.4）的 `completeSimple` 把消息和工具定义交给模型。只用这一调用，不用会话、OAuth、流式。请求不传 `reasoning`：这一版的请求档没有 `off`，不传时智谱这条线的 thinking 是关掉的。
3. 模型调用 `exec`，或调用**已种子化**的工具：执行命令，把结果追加进消息，再问一次。命令失败也是一条普通输出，循环不因此停止。
4. 一次 act 失败，或 act 连续成功 10 次：插入一次 reflect。见下一节。
5. 模型调用本身返回 error：把 `errorMessage` 追加成一条 user 消息，再问一次。不因此停，也不因此去问 JEV，也不因此进入 reflect。
6. 模型不再调用工具：把题面和产物交给 JEV 做一次是否完成的判断。产物是工作区相对 `HEAD` 的 diff；没有 diff 时用模型最后一段文字。
7. JEV 判完成：停。判未完成：在同一份消息后追加「未完成，继续」，再跑一轮。不另开一份被截断的记录。

未传入 `judge` 时，模型不再调用工具即停（内循环单测用）。正式跑传入 `jevJudge`，不设步数或轮次上限。停只发生在 JEV 判完成，或调用被中止。密钥在 MCP Guard 保险箱，条目名 `JEV_KEY`。用保险箱把该条目注入环境后执行 `node scripts/write-jev-key-env.mjs`，写入仓库根 `.env`（已 gitignore）。

## Reflect（无 create_tool）

Act 是主循环。Reflect 看同一份消息，用单独的提示词。它自己的回复和工具结果不写回主消息。

**没收 `create_tool`。** 运行中不得扩张 act 工具表。工具只来自**跑前种子**（见下节）。这与 [`TOOL-MDL-GROWTH.md`](./TOOL-MDL-GROWTH.md) 臂 A≈0 / 离线长词表一致：内循环不 invent 动作词汇。

触发：

- 一次 act 执行失败（命令非 0、空命令、未知工具，以及已登记工具执行失败）
- act 连续成功满 10 次。成功计数在失败时清零，满 10 次并完成这次 reflect 后也清零

Reflect 的工具（均可选调用；也可只回复文字结束）：

| 工具 | 作用 |
|------|------|
| `upsert_rule` | 写入或覆盖一条 **rule**（短约束 / 失败后教训）。落盘 `{cwd}/.agent/rules/<id>.md`，并进入后续 act 的 system prompt。 |
| `upsert_skill` | 写入或覆盖一个 **skill**（可复用步骤说明书）。落盘 `{cwd}/.agent/skills/<name>/SKILL.md`，并进入后续 act 的 system prompt。 |
| `retire_rule` / `retire_skill` | 删掉已沉淀的条目，并从 act 提示词撤出。 |

约定：

1. **经验只走 rule/skill**：踩坑、验收顺序、下载等待条件写 rule/skill，不要幻想再登记 shell。
2. **单次 Reflect 有硬上限**：默认最多 **4** 轮 LLM、合计 **6** 次 Reflect 工具调用；到顶强制结束回 act。
3. Reflect 对话本身不进主消息；只有落盘的 rule/skill 与跑前种子工具会留下。

## 事后分析 → 种子 → 新 agent

工具与跨次经验**不在同一次 live reflect 里 invent**，而按：

```text
跑 N（仅 exec ± 旧种子）
  → 事后分析（人 / 脚本 / 另一模型：阶段耗时、反复错误、可脚本化点）
  → 写入 seed/（rules · skills · 可选 tools.json）
  → 跑 N+1：place() 把 seed 拷进 work/.agent/ 再启动
```

| 种子文件 | 作用 |
|----------|------|
| `.agent/rules/*.md` | 开局进 act system prompt |
| `.agent/skills/*/SKILL.md` | 同上 |
| `.agent/tools.json` | 可选。跑前登记为 act 可调工具（`name` / `description` / `command` / 可选 `parameters`）。**只有分析/人写入，agent 运行时不能增删。** |

Kura 冒烟的分析种子：`experiments/exec-agent-kura-h5/seed/`（由上次 complete 跑的过程优化结论整理）。`run-kura-h5.ts` 在 `git init` 后把该目录拷入 `work/.agent/`。

## 工具

Act **默认只有 `exec`**。若种子含 `tools.json`，那些工具在第一轮 act 即可见。每次命令是新的 shell，工作目录是调用方传入的 `cwd`。

### 使用率（历史对照；create_tool 时代）

| 跑次 | 登记 | act 用过 | 使用率 | 备注 |
|------|------|-----------|--------|------|
| 纪律前（complete） | 78 | 1 | **1.3%** | 其余从未进 act |
| 没收 create_tool 后 | 仅种子 | — | — | 以内联 invent 为零为目标 |

## 冒烟题：Kura H5 3D 地图（打光上色 + 视觉验收）

按 [Kura AGENT.md](https://kuroneko.chat/assets/AGENT.md) 从资产仓拉模型，做可玩的 H5 3D 地图；场景必须主动打光照上色；按种子 skill 用 exec（或种子工具）截图并写视觉证明——**不再要求运行时 create_tool**。

- 题面：`experiments/exec-agent-kura-h5/instruction.md`
- 种子：`experiments/exec-agent-kura-h5/seed/`
- 跑法：`npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-kura-h5.ts`
- 进度页：`npx --yes tsx packages/server/src/openkuroneko/exec-agent/progress-server.ts` → [http://127.0.0.1:8932](http://127.0.0.1:8932)
- 工作区：`experiments/exec-agent-kura-h5/work/`（gitignore）；进度：`live/`（gitignore）
- 资产入口：仅公网 [`https://kuroneko.chat/assets`](https://kuroneko.chat/assets/AGENT.md)
- 硬检查：真实 GLB、灯光与上色、`reports/scene*.png` + `reports/vision-proof.md`；若有种子识图工具则应调用，否则用 exec 按 skill 完成同等验收

## 对照实验：game-eval 2048（kurenai · miniagent vs Cursor）

考场在 fork 的 game-eval；本仓只提供 **exec-only** 考生臂。

- 协议 / prepare / compare：`~/Documents/sub-private/game-eval/experiments/kurenai-miniagent-vs-cursor/`
- 题面包装 + seed：`experiments/exec-agent-gamegen-2048/`
- 跑法：`GAME_EVAL_WORKDIR=<candidate> npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-gamegen-2048.ts`
- 或：`…/game-eval/experiments/kurenai-miniagent-vs-cursor/run-miniagent.sh`
- **不**清空 Candidate；只注入 seed（`tools.json` 为空 → act 仅 `exec`）
- 进度：`experiments/exec-agent-gamegen-2048/live/`

## 冒烟题：Blender 青蛙 → H5（桥 HTTP + 视觉验收）

用本机已打开的 Blender（[blender-meta-mcp](https://github.com/kurenai-studio/blender_meta_mcp) addon，默认 `http://127.0.0.1:11588`）经 **exec + curl** 调 bpy 建青蛙，导出 GLB，再做 three.js H5 展示并视觉验收。**无 create_tool**；不经 Cursor MCP 工具表（agent 只有 shell）。

当前题面要求：**精细有机体流水线**（种子 `fine_organic_model`）：Skin 骨架 → 闭壳 remesh → lookdev 静帧闸门 → **程序化材质 bake 进贴图** → GLB → 电影光 H5 → 视觉验收。禁止下载成品蛙、禁止复用 `saved/` 旧产物。

前置：Blender 已开且 addon 启用（侧栏 MCP 显示监听）。桥不可达则任务无法完成。

- 题面：`experiments/exec-agent-blender-frog/instruction.md`
- 种子：`experiments/exec-agent-blender-frog/seed/`（`fine_organic_model` / `bake_procedural_for_gltf` / `lookdev_render_loop` + 桥与截图纪律）
- 人工 Cursor 对照产物：`experiments/exec-agent-blender-frog/saved/`（gitignore；`run` 会清空 `work/`，旧版勿放 `work/` 下）
- 跑法：`npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-blender-frog.ts`
- 进度：`EXEC_AGENT_EXPERIMENT=exec-agent-blender-frog EXEC_AGENT_PROGRESS_PORT=8933` 起 progress-server
- 工作区：`experiments/exec-agent-blender-frog/work/`（gitignore）
- 硬检查：`frog.glb`、`index.html` 加载该模型、灯光/上色、`reports/scene*.png` + `reports/vision-proof.md`（须描述材质/高光/眼神光）

## 代码

`packages/server/src/openkuroneko/exec-agent/loop.ts`（含 `onEvent`、种子加载）  
跑题：`run-deepswe.ts`、`run-kura-h5.ts`、`run-blender-frog.ts`；进度页：`progress-server.ts` + `live-progress.ts`
