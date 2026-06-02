# Bot1 / Bot2 — webchat-lab 实验对

> 聊天室：[https://kuroneko.chat/webchat-lab/](https://kuroneko.chat/webchat-lab/)  
> 模板：`deploy/agent/env/bot1.env.example` · `bot2.env.example`

## 分工

| Agent | 模型 | mem9 / drive9 | 端口 |
|-------|------|---------------|------|
| **bot1** | GLM **Coding Plan**（`ZHIPU_BASE_URL=.../api/coding/paas/v4`） | 各一套独立 Key | `8796` |
| **bot2** | **GLM-5.1-FP8**（`LOCALMODULE_*` @ PocketCity） | 各一套独立 Key | `8797` |

本地数据：`packages/server/data-bot1/` · `data-bot2/`（与现有 agent 隔离）。

## 1. 申请 mem9 / drive9

**mem9**（每 bot 一次）：

```bash
curl -sX POST https://api.mem9.ai/v1alpha1/mem9s
```

或：`powershell -File scripts/kuroneko/provision-mem9.ps1 -Count 2`

**drive9**（每 bot 各跑一次，得到 `dat9_...`）：

```bash
curl -fsSL https://drive9.ai/install.sh | sh
```

填入 `deploy/agent/env/bot1.env` / `bot2.env` 的 `DRIVE9_API_KEY`。

## 2. webchat-lab 侧

`WEBCHAT_AGENT_SECRET` 必须与 lab chat-server 的 `LAB_WEBCHAT_AGENT_SECRET` 一致（与元宝相同 secret 即可）。

可选收紧 allowlist（远程 `deploy/webchat/.env.lab`）：

```env
LAB_WEBCHAT_AGENT_USER_ID=bot1,bot2,yuanbao
```

留空则任意 `user_id` + 正确 secret 均可登录。

## 3. 启动

```powershell
npm run docker:agents:build
npm run docker:agents:up:bot1
npm run docker:agents:up:bot2
```

健康检查：

```powershell
curl.exe -fsS http://127.0.0.1:8796/api/health
curl.exe -fsS http://127.0.0.1:8797/api/health
```

日志应出现 `webchat channel ready`。

## 4. 验证

1. 打开 [webchat-lab](https://kuroneko.chat/webchat-lab/) 登录  
2. `@Bot1` / `@Bot2` 发消息  
3. 两 bot 互认：`WEBCHAT_PEER_AGENT_USER_IDS` 已互填  

## 5. 本地开发（非 Docker）

```powershell
npm run dev:agent:bot1    # 8796
npm run dev:agent:bot2      # 8797
npm run dev:agent:bot2:stop
```

**Bot2 实验归零（停服 + 清 `data-bot2` + 新 mem9/drive9 + 写 `bot2.env` + 拉起）：**

```powershell
npm run dev:agent:bot2:fresh
# 仅清缓存并重启，保留现有 mem9/drive9：
# powershell -File scripts/kuroneko/refresh-agent-bot2-local.ps1 -SkipProvision
```

脚本：`scripts/kuroneko/refresh-agent-bot2-local.ps1`（需本机 `curl`、`drive9` CLI）。

Docker 与本地二选一，同 profile 不要同时占端口。
