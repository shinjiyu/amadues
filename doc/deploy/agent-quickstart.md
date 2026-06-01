# Agent 一键部署 / Agent quick deploy

面向运维与 Agent 集成：**一个 Docker 容器 = 一个 Agent 实例**。不假设固定主机名、端口或角色名称；实例身份由环境变量定义。

English summary: copy `agent.env.example`, set LLM + channel secrets, pick a Compose **profile**, `up -d`. Health at `GET /api/health`.

---

## 1. 前置条件

- Docker Engine（或 Docker Desktop）与 Compose v2
- 本仓库已 `npm install` 且 `npm run build`（构建镜像时会用到）
- 至少一种 LLM API Key（智谱 / OpenAI 兼容端点等）
- **推荐** [mem9](https://mem9.ai/) + [drive9](https://drive9.ai/) API Key（语义记忆与技能库；申请步骤见 **[mem9-drive9-credentials.md](./mem9-drive9-credentials.md)**）
- 若接 WebChat：已部署 `apps/chat-server`，并持有与 server 一致的 `WEBCHAT_AGENT_SECRET`

---

## 2. 配置实例（约 3 分钟）

```bash
cd <repo-root>
cp deploy/agent/env/agent.env.example deploy/agent/env/my-instance.env
```

编辑 `deploy/agent/env/my-instance.env`：

| 变量 | 含义 |
|------|------|
| `UTLRA_AGENT_IM_SID` | 稳定身份 ID，如 `idp:agent:my-instance` |
| `UTLRA_AGENT_NAME` | 对外显示名（IM / 日志） |
| `ZHIPU_API_KEY` 或 `LOCALMODULE_*` / `KIMI_*` | 至少一种文本模型 |
| `MEM9_API_KEY` / `DRIVE9_API_KEY` | **推荐**；语义记忆与技能库（[如何申请](./mem9-drive9-credentials.md)） |
| `UTLRA_CHAT_CHANNEL` | `webchat` · `discord` · `none` |
| `WEBCHAT_*` | 接 WebChat 时必填（见 example 内注释） |
| `DISCORD_BOT_TOKEN` | 接 Discord 时必填 |

**不要**在 env 里设置 `PORT` 或 `UTLRA_DATA_ROOT`——Compose 会注入。

`WEBCHAT_AGENT_USER_ID` 必须与 chat-server 上为该实例注册的 agent user id 一致；`WEBCHAT_AGENT_SECRET` 必须与 server 配置相同。

---

## 3. 注册 Compose profile（首次）

在 `deploy/agent/docker-compose.agent.yml` 中为该实例增加一段 service（可复制现有 service 块并改）：

- `profiles: ["my-instance"]`
- `env_file: env/my-instance.env`
- `ports: "127.0.0.1:<host-port>:8787"`
- `volumes: ../../packages/server/data-<instance>:/data`

并在 `scripts/kuroneko/_agent-docker.ps1` 的 profile→container 映射中增加同名项（若使用仓库自带启停脚本）。

仅想快速验证时，也可直接使用仓库里**已有 profile 名**对应的那份 `*.env.example`，复制为同名 `*.env` 后修改身份与密钥（profile 列表见 compose 文件，不在本文枚举具体别名）。

---

## 4. 一键启动

```bash
cd <repo-root>
npm run docker:agents:build

docker compose -f deploy/agent/docker-compose.agent.yml \
  --profile my-instance up -d --build
```

或使用 PowerShell 包装脚本（若已为该 profile 添加 `start-agent-*.ps1`）：

```powershell
# 示例：npm run docker:agents:up:<profile>
```

---

## 5. 验收

```bash
curl -fsS http://127.0.0.1:<host-port>/api/health
```

期望 JSON 含 `ok: true` 与 `dataRoot`。

接 WebChat 时，查看容器日志应出现 channel 已连接、`ready (online)`。

**离线调试**（未配渠道）：`POST /api/outer/roundtrip`，body 含 `message` / `thread_id` 等（见 [inner-outer-protocol.md](../inner-outer-protocol.md)）。

---

## 6. 停止与升级

```bash
docker compose -f deploy/agent/docker-compose.agent.yml \
  --profile my-instance stop

docker compose -f deploy/agent/docker-compose.agent.yml \
  --profile my-instance up -d --build
```

数据持久化在挂载的 `packages/server/data-<instance>/`（已在 `.gitignore`）。

---

## 7. 多实例与 WebChat

- 每个实例：**独立 env、独立数据卷、独立 Compose profile**。
- 同一 chat-server 上多实例：`WEBCHAT_AGENT_USER_ID` 各不相同；server 端 `WEBCHAT_AGENT_USER_ID` 可逗号列出多个保留 id；各实例 env 中 `WEBCHAT_PEER_AGENT_USER_IDS` 列出**其他**实例的 user id（不含自己）。
- 详细 Docker 布局：[../ops/agent-docker.md](../ops/agent-docker.md)

---

## 8. 监控 UI（可选）

```bash
npm run dev:dashboard
```

Dashboard 通过 Vite 代理访问各实例 HTTP API；代理端口在 `apps/dashboard/vite.config.ts` 中配置，按你的实例数扩展即可。

---

## 相关文档

- **[mem9 / drive9 密钥申请](./mem9-drive9-credentials.md)**（官方链接 + curl 开通示例）
- [Agent 接入指南](../agent-integration-guide.md)
- [渠道桥接](../channel-bridge-guide.md)
- [内外脑协议](../inner-outer-protocol.md)
- [agent-docker.md](../ops/agent-docker.md)
