# Agent Docker 隔离部署

每个 agent **一个容器、一份 env 文件、一个身份**（容器内都是「单 agent」实例）。

---

## 配置文件（不入库）

```text
deploy/agent/env/
  kuroneko.env.example  → 复制为 kuroneko.env
  shiro.env.example     →  shiro.env
  gin.env.example       →  gin.env
  aoi.env.example       →  aoi.env
```

首次 `npm run docker:agents:up` 时，若缺少 `*.env` 会：

1. 优先从仓库根 `.env.<agent>` 复制（如 `.env.kuroneko`、`.env.shiro`）
2. 再尝试旧名（`.env` → kuroneko，`.env.agent2` → shiro）
3. 否则从 `*.env.example` 复制
4. 去掉 `PORT` / `UTLRA_DATA_ROOT`（由 compose 注入 `/data` 与 `8787`）

同步：修改 `deploy/agent/env/<name>.env` 后，根目录 `.env.<name>` 会在下次 `docker:agents:up` 时被覆盖为相同内容。

**务必**在各自 `*.env` 中填入 LLM 密钥与渠道配置（如 `WEBCHAT_AGENT_SECRET`）。

---

## 启动

```bash
npm run docker:agents:up          # 四实例
npm run docker:agents:up:aoi      # 单个
npm run docker:agents:down
```

| 实例 | 宿主机 API | 数据目录 | env 文件 |
|------|-----------|----------|----------|
| Kuroneko | 8787 | `packages/server/data` | `env/kuroneko.env` |
| Shiro | 8788 | `data-shiro` | `env/shiro.env` |
| Gin | 8789 | `data-gin` | `env/gin.env` |
| Aoi | 8791 | `data-aoi` | `env/aoi.env` |

Dashboard `5173` 仍通过 `/api`–`/api4` 代理到上述端口（只读监控）。

容器使用 `restart: unless-stopped`：Docker 守护进程重启后，**未手动 stop** 的容器会自动起来。

---

## 已移除：本机 agent 模式

不再有 `npm run dev:server` / `dev:agent2` / `dev:gin` / `dev:aoi`。  
Agent 进程 **仅** Docker；开发 server 包请用单测 / `UTLRA_SKIP_AGENT_BOOTSTRAP=1`。

---

## WebChat

**本地联调**（chat-server 在宿主机 8790）：

```env
WEBCHAT_API_BASE=http://host.docker.internal:8790/api
WEBCHAT_WS_URL=ws://host.docker.internal:8790/ws
```

（Linux Docker 可用 `http://172.17.0.1:8790` 或 compose `extra_hosts`。）

**生产 / 远程 chat-server**：改为你的公网或内网地址，例如：

```env
WEBCHAT_API_BASE=https://your-chat-host/webchat/api
WEBCHAT_WS_URL=wss://your-chat-host/webchat/ws
```

`WEBCHAT_AGENT_SECRET` 须与 chat-server 端一致。
