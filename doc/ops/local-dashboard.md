# 注册到 local-dashboard / Register with local-dashboard

> **English:** **local-dashboard** is an **optional** host-level ops UI (default `http://127.0.0.1:9780`). This repo ships a Kuroneko service bundle you can merge into your own local-dashboard install under page id **`kuroneko`**.

## 和 Dashboard（5173）有什么区别？

| 面板 | 地址 | 干什么 |
|------|------|--------|
| **local-dashboard** | `http://127.0.0.1:9780/?page=kuroneko` | **启停**：Dashboard（5173）、Drive9 Explorer |
| **Dashboard（业务）** | http://127.0.0.1:5173 | **看内脑/外脑状态**（只读监控），顶栏切换 Kuroneko / Shiro / Gin / Aoi |
| **Ops Console** | http://127.0.0.1:7779 | Agent 启停日志（`npm run dev:ops`；不在 9780 注册） |

改了 `scripts/kuroneko-utlra.bundle.json` 后，在 **本仓库根**执行一次同步，9780 里才会出现最新服务项。

## 一键同步（推荐）

```powershell
cd <repo-root>
.\scripts\sync-local-dashboard.ps1
# 自定义 local-dashboard 安装路径：
# .\scripts\sync-local-dashboard.ps1 -LocalDashboardRoot C:\path\to\local-dashboard
```

会复制 `scripts/kuroneko-utlra.bundle.json` + `scripts/kuroneko/*.ps1` 到目标 local-dashboard，并运行 `merge-kuroneko-bundle.mjs` 更新 `registry.json`。

**local-dashboard**（外部仓库，自行 clone/安装）与仓库内 **ops-console**（`npm run dev:ops`）分工：

| 工具 | 端口 | 作用 |
|------|------|------|
| **local-dashboard** | 9780 | 全机托管：Docker Agent、chat-server 等 |
| **ops-console UI** | 7779 | 服务卡片 + 启停脚本输出（API 7777） |

## 已注册服务（分组 `kuroneko`）

local-dashboard 仅托管 **Dashboard** 与 **Drive9 Explorer**；四 Agent / Ops 请用 `npm run docker:agents:*` 或命令行单独启停（见 [`agent-docker.md`](./agent-docker.md)）。

| ID | 说明 | 端口 |
|----|------|------|
| `kuroneko-dashboard` | 业务控制台 H5 | 5173 |
| `kuroneko-drive9-explorer` | Drive9 文件浏览器 | 7782（API 7780） |

启停脚本：`scripts/local-dashboard/{start,stop,health}.ps1`。仓库根目录可用环境变量 **`KURONEKO_ROOT`** 覆盖（默认从脚本位置自动解析）。

## 手动合并（未用 sync 脚本时）

在 **你的 local-dashboard 仓库根**：

```powershell
# 先把本仓库的 bundle + scripts/kuroneko 复制过去，再：
node scripts/merge-kuroneko-bundle.mjs
```

权威源：[`scripts/kuroneko-utlra.bundle.json`](../../scripts/kuroneko-utlra.bundle.json)、[`scripts/kuroneko/`](../../scripts/kuroneko/)。

## Ops Console

仓库根 `npm run dev:ops`，浏览器 **http://127.0.0.1:7779/**。

> Agent 容器在 **9780** 或 `npm run docker:agents:*` 启停；`docker logs utlra-agent-<name>` 查看运行时日志。

| Agent | 端口 | 配置 |
|-------|------|------|
| Kuroneko | 8787 | `deploy/agent/env/kuroneko.env` |
| Shiro | 8788 | `deploy/agent/env/shiro.env` |
| Gin | 8789 | `deploy/agent/env/gin.env` |
| Aoi | 8791 | `deploy/agent/env/aoi.env` |

详见 [`agent-docker.md`](./agent-docker.md)。
