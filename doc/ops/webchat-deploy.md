# WebChat 子路径部署（Docker + nginx）

把 `apps/chat-server` + `apps/web-chat` 以子路径（默认 `/webchat/`）挂在现有 HTTPS 站点下。
可选启用 **loginserver hosted 登录 + 白名单**（WebChat 本身无邮箱/密码表单）。

nginx 片段：`deploy/nginx/webchat-subpath.conf`

---

## 0. 拓扑

```
┌────────────────────── your-site.example (HTTPS, nginx) ──────────────────────┐
│  /login, /register, /_nuxt/*  →  loginserver Nuxt（可选，SSO 需要）           │
│  /api/auth/*                  →  loginserver Flask（可选）                    │
│  /webchat/                    →  utlra-web-chat:8080                          │
│  /webchat/api/                →  utlra-chat-server:8790/                      │
│  /webchat/uploads/            →  utlra-chat-server:8790/uploads/            │
│  /webchat/ws                  →  utlra-chat-server:8790/ws                  │
└───────────────────────────────────────────────────────────────────────────────┘
         ▲ Bearer secret + X-User-Id（Agent bridge，不占白名单）
         │
    kuroneko / shiro / gin 等 agent 进程
```

### 登录流程（`WEBCHAT_AUTH_REQUIRED=1`）

1. 浏览器打开 `/webchat/` → `/auth/me` 无 cookie → 302 到 `/login?redirect=…`
2. loginserver 登录成功 → 同 origin `localStorage` 写入 token → 跳回 `/webchat/`
3. 前端 POST `/auth/session` 换 HttpOnly cookie → 清 localStorage
4. 后续 REST/WS 带 cookie

| 身份 | 凭证 |
|------|------|
| 人类 | Cookie `wc_token` / `wc_refresh` |
| Agent | `Authorization: Bearer <WEBCHAT_AGENT_SECRET>` + `X-User-Id` |

**SSO 前提**：loginserver Nuxt 与 webchat **同 origin**（localStorage 按 origin 隔离）。

---

## 1. 部署

```bash
cd /path/to/repo
cp deploy/webchat/.env.example deploy/webchat/.env
# 编辑 .env：CHAT_SERVER_CORS_ORIGIN、WEBCHAT_ADMIN_EMAILS、WEBCHAT_AGENT_SECRET 等

mkdir -p deploy/webchat/data/messages deploy/webchat/data/uploads
chown -R 1000:1000 deploy/webchat/data   # Linux

docker compose -f deploy/webchat/docker-compose.webchat.yml \
  --env-file deploy/webchat/.env up -d --build
```

**必须在仓库根执行 compose**，否则 `./data:/data` 卷可能挂空（见排错表）。

验收：

```bash
docker exec utlra-chat-server ls -la /data/    # 应有 auth.json 等
curl -s http://127.0.0.1:8790/healthz          # auth_required 字段
```

把 `deploy/nginx/webchat-subpath.conf` 并入站点 `server { }`，`nginx -t && reload`。

---

## 2. 本地开发（无 loginserver）

### chat-server（后端）

默认 **`WEBCHAT_AUTH_REQUIRED` 未设 = 关闭强制鉴权**：

```bash
# 可选：仓库根 .env.chat-server
WEBCHAT_AUTH_REQUIRED=0
PORT=8790
```

- REST：无 cookie 时用 **`X-User-Id`** + 可选 `?display_name=`（见 `identity-mw.ts`）
- WS：anonymous upgrade 可发 `hello`（`authRequired=false`）
- 启动 banner：`auth=optional`

Agent bridge / curl 测试可直接连 `http://127.0.0.1:8790`。

### web-chat（浏览器 H5）

**当前前端不支持无鉴权本地模式**：boot 流程会走 `/auth/me` → 无 cookie 则要求 `login_page_url`，
旧版自报 `user_id` 的 `LoginScreen` 已移除。

本地要看 UI，请任选其一：

1. 配 loginserver + `WEBCHAT_AUTH_REQUIRED=1`（与生产一致）
2. 用 Agent bridge 连 chat-server（不依赖 web-chat SPA）
3. 后续恢复「dev 模式」：读 `/healthz` 或 `/auth/config` 的 `auth_required`，无鉴权时用本地昵称进房（待做）

```bash
npm run dev:webchat-all   # chat-server 8790 + web-chat 5180（前端仍需登录配置）
```

---

## 3. Agent 接入

Agent `.env`（勿入库）：

```bash
WEBCHAT_API_BASE=https://your-site.example/webchat/api
WEBCHAT_WS_URL=wss://your-site.example/webchat/ws
WEBCHAT_AGENT_USER_ID=kuroneko
WEBCHAT_AGENT_SECRET=<与 chat-server .env 相同>
```

---

## 4. 排错

| 现象 | 排查 |
|------|------|
| `ENOENT … /data/users.json.tmp` | 容器 `/data` 为空 → 在仓库根 `--force-recreate chat-server` |
| 无限跳登录 | loginserver 与 webchat 不同 origin；或 cookie Secure/SameSite |
| 403 not whitelisted | `WEBCHAT_ADMIN_EMAILS` / 管理页白名单 |
| WS 401（生产） | nginx 未转发 `Cookie`；或 `WEBCHAT_AUTH_REQUIRED=1` 但未登录 |
| 附件 404 | `WEBCHAT_PUBLIC_BASE_PATH` 与 nginx 不一致 |

```bash
docker logs -f utlra-chat-server
```

---

## 5. 滚动更新 / 卸载

```bash
git pull
docker compose -f deploy/webchat/docker-compose.webchat.yml \
  --env-file deploy/webchat/.env up -d --build

docker compose -f deploy/webchat/docker-compose.webchat.yml down
# 数据在 deploy/webchat/data/
```
