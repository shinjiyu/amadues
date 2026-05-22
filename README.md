# utlraKuroneko

绿场实现的 Agent 栈：**数据落地（办公室 `.run/`）**、**身份 + Chat IR**、**Structured Reply**、**内脑运行时**，并带 **Web 仪表盘**（数据层可视化 + 内脑交互与状态）。

设计文档见上级目录 [`../doc/`](../doc/)（`data-layer-phase1-draft.md`、`chat-ir-identity-design.md`、`greenfield-milestones.md`）。

**远程仓库**：<https://github.com/shinjiyu/utlraKuroneko>

## 要求

- Node.js ≥ 20

## 智谱 AI（可选）

1. 复制 `.env.example` 为 `.env`，填写 `ZHIPU_API_KEY`。  
2. **切勿**把 `.env` 提交到 Git；**切勿**在聊天/工单中明文发 Key（泄露后请立即在[控制台](https://open.bigmodel.cn/)轮换）。  
3. **GLM Coding Plan（编码套餐）**须使用专属 Base URL：[`https://open.bigmodel.cn/api/coding/paas/v4`](https://docs.bigmodel.cn/cn/coding-plan/quick-start)，**不要**用通用 `https://open.bigmodel.cn/api/paas/v4`。  
4. 纯文本默认 **`glm-5.1`**（见 [GLM-5 系列](https://docs.bigmodel.cn/cn/guide/models/text/glm-5)，以控制台实际模型名为准）；**带图**时为 **单次多模态**调用，默认 **`glm-5v-turbo`**（`ZHIPU_VISION_MODEL` 可按控制台实际名称调整）。  
5. 建议 `ZHIPU_THINKING=disabled`，`ZHIPU_MAX_TOKENS` / `ZHIPU_MULTIMODAL_MAX_TOKENS` 按套餐额度调整。

### Pi-mono 内脑（与 openKuroneko 同源控制器）

Pi-mono 运行时 **内嵌** 于本仓库（`packages/server/src/openkuroneko/`，由 `@utlra/server` 一并编译），实现 **DECOMPOSE / EXECUTE / ATTRIBUTE / BLOCKED / SLEEPING** 控制器（全套工具 + 智谱 OpenAI 兼容适配器）。**不再需要**并列克隆 openKuroneko 或配置 `OPENKURONEKO_DIST`。

- **Pi-mono 单步**：`POST /api/inner/:ws/pi-tick` — 调用**一次** `Controller.tick()`（一个**宏步**）。
  - 不是「一次 LLM 一行字」：例如 **EXECUTE** 这一宏步里，Executor 可能跑**多轮** LLM + 工具，直到本轮执行结束再进入 ATTRIBUTE。
  - **DECOMPOSE** 宏步通常是一次 Decomposer LLM 并写 `milestones.md`。
- **Pi-mono Auto**：`POST /api/inner/:ws/pi-auto`，body `{ "maxTicks": 500 }`（可选；默认环境变量 **`UTLRA_PI_AUTO_MAX_TICKS`** 或 500）。在**同一次 HTTP 请求**内，用**同一** controller 实例**连续** `tick()`，直到某次 `hadWork=false`（本轮无事可做）或达到 `maxTicks`。类似 CLI fast 调度里「有活就连跑」的一段 burst；**不等于**在 BLOCKED/缺输入时仍能自动跑完全部人生任务。
- **Goal** 权威路径 `.brain/goal.md`（经 `InnerBrainEngine.setGoal`）；临时文件在 `.run/pi-mono/`。
- `workdir-guard` 为进程单例，Pi-mono 请求**串行**。

仪表盘 **内脑** 页可点 **「LLM 一步」** 调用 `POST /api/inner/:ws/llm-step`（需已设置 Goal）。

### M5 RepositoryStore（执行轨 / 交互轨）

- `POST /api/repository/:tenant/commit` — body：`{ session_id, realm, lane: "execution"|"interaction", items: [{ kind: "knowledge"|"skill"|"policy", title, body, tags? }] }`  
- `POST /api/repository/:tenant/retrieve` — body：`{ query, realm?, lane?, limit? }`（关键词粗排；`data/repository/` 下按租户持久化）

### M6 外脑编排（正式边界：启动与关闭内脑）

- `GET /api/outer/inner-status/:ws` — 读当前内脑聚合状态（与 Dashboard 同源）。  
- `POST /api/outer/roundtrip` — 追加 thread 消息 → 设 Goal → **子进程** `inner-worker` 跑一段 Pi-mono Auto → 返回 `StructuredReply`、`mock`、**`lifecycle`**（burst 后是否按策略晋升并关闭内脑）。  
  - body：`text` **或** `parts`（与 `message.v1` 相同的 `MessagePart[]`）；可同时给 `text`（会作为首段 text part）。图片可用 `attachment` + `data:image/...;base64,...`，落盘到 workspace `.run/outer-task-media/` 并写入 goal.md（详见 `doc/inner-outer-protocol.md` §7）。  
  - 其它：`after_burst`、`tenant_id`、`realm`。  
  - 环境变量 **`UTLRA_OUTER_AFTER_BURST=promote_and_shutdown_if_complete`**：当磁盘上已出现「目标已完成」时，自动执行与 `promote-and-shutdown` 相同的顺序（manifest → Repository → SLEEPING）。  
- `POST /api/outer/workspace/:ws/shutdown` — 外脑主动关闭内脑：`promote_manifest: true` 为先晋升再休眠；`false` 或省略为仅休眠。  

详细规则见 [`../doc/inner-outer-protocol.md`](../doc/inner-outer-protocol.md)。控制台「数据层」里的 Repository 表格为 **调试** 用途。

### M7 Chat IR + Discord 渠道桥

- **`@utlra/chat-ir`**：chat IR 独立模块——数据模型（`MessageRecord` / `ThreadRecord` / `IdentityRecord`）、`IdentityRegistry`、`ChatAssetStore`、`LooseThreadStore`、`ChatIRChannel` 接口、`StructuredReply` 输出契约。可被任意渠道桥与 agent 实现复用。
- **`workspace-kit`**（`packages/server/src/workspace-kit`）：外脑 workDir 工具（原 `@utlra/core`，已内联），与 chat IR 解耦。
- **`@utlra/discord-bridge`**：`DiscordChannel`（implements `ChatIRChannel`）—— 直接对接 Discord Gateway / REST，落 chat IR 与触发 agent callback 全部进程内完成，**没有中间 IM Server**。
- **配置**：`.env` 里设 `DISCORD_BOT_TOKEN` 启用；不设则退化为 `NullChatIRChannel`（postMessage 仅打日志，HTTP `/api/outer/roundtrip` 仍可用）。
- **数据落盘**：`UTLRA_DATA_ROOT` 下 `chat/threads.json`、`identities.json`、`chat/uploads/` 由 agent 进程统一持有。

详细架构见 [`doc/chat-ir-identity-design.md`](./doc/chat-ir-identity-design.md) §10；接入新渠道见 [`doc/channel-bridge-guide.md`](./doc/channel-bridge-guide.md)。

## 安装与开发

```bash
cp .env.example .env
# 编辑 .env 填入 ZHIPU_API_KEY（可选）+ DISCORD_BOT_TOKEN（可选）
npm install
npm run build
npm run dev
```

- 核心 API：<http://localhost:8787>
- 核心仪表盘：<http://localhost:5173>（Vite 已代理 `/api` → 8787）
- Discord 已配 token 时，agent 启动后直接连 Discord Gateway

或分两终端：

```bash
npm run dev:server
npm run dev:dashboard
```

**离线调试**（未配 Discord 时）：
直接 `POST http://127.0.0.1:8787/api/outer/roundtrip` 触发完整 OuterBrain roundtrip，写 `<DATA_ROOT>/chat/threads.json`。

## 第一目标范围

- M0–M4：核心协议与简化内脑循环  
- **数据层可视化**：浏览 workspace、`.run/manifest`、目录树  
- **内脑 UI**：设置 goal、Tick、状态与遥测

## 同步到 GitHub

```bash
git remote add origin https://github.com/shinjiyu/utlraKuroneko.git
git push -u origin main
```

（若远程已有空仓库，首次推送用 `main` 或 `master` 与 GitHub 默认分支一致。）
