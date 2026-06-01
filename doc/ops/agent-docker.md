# Agent Docker 部署

每个 Agent **一个容器、一份 env、一个数据卷**。实例名称由你在 `deploy/agent/docker-compose.agent.yml` 中定义的 **Compose profile** 决定，而非固定角色名。

一键流程见 **[../deploy/agent-quickstart.md](../deploy/agent-quickstart.md)**。

---

## 配置文件（不入库）

```text
deploy/agent/env/
  agent.env.example     → 通用模板（推荐新实例从此复制）
  <instance>.env        → 你的实例密钥（gitignore）
```

首次启动脚本会：

1. 若缺少 `<instance>.env`，尝试从仓库根 `.env.<instance>` 或 `*.env.example` 复制
2. 去掉 `PORT` / `UTLRA_DATA_ROOT`（由 compose 注入）

**务必**填入 LLM 密钥与渠道配置（如 `WEBCHAT_AGENT_SECRET`）。

---

## 启动

```bash
npm run docker:agents:build

docker compose -f deploy/agent/docker-compose.agent.yml \
  --profile <instance> up -d --build
```

停止：

```bash
docker compose -f deploy/agent/docker-compose.agent.yml \
  --profile <instance> stop
```

仓库 `package.json` 中的 `docker:agents:up:*` 脚本是对上述命令的 PowerShell 包装；profile 名以 compose 文件为准。

---

## 数据卷

每个 service 挂载 `packages/server/data-<instance>:/data`（路径在 compose 中配置）。运行时 chat、registry、workspaces 均在此目录，**已在 `.gitignore`**。

---

## WebChat 连接

容器内访问宿主机或远程 chat-server：

```env
WEBCHAT_API_BASE=https://<host>/<path>/api
WEBCHAT_WS_URL=wss://<host>/<path>/ws
WEBCHAT_AGENT_USER_ID=<your-agent-user-id>
WEBCHAT_AGENT_SECRET=<shared-secret>
```

`WEBCHAT_AGENT_SECRET` 必须与 chat-server 端一致。多实例时各 env 的 `WEBCHAT_AGENT_USER_ID` 不同，server 端注册多个保留 id。

本地联调常用 `host.docker.internal`（Docker Desktop）；Linux 可用网关 IP 或 compose `extra_hosts`。

---

## 运行模式说明

- Agent 服务端 **推荐仅通过 Docker 运行**（`packages/server/Dockerfile`）。
- 包内开发与单测可使用 `UTLRA_SKIP_AGENT_BOOTSTRAP=1` 等，见测试文档。

---

## 监控

可选：`npm run dev:dashboard` 启动只读 UI；在 `apps/dashboard/vite.config.ts` 中为各实例 HTTP 端口配置反向代理前缀。
