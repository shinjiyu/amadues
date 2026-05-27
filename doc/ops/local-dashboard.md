# 注册到 local-dashboard / Register with local-dashboard

> **English:** **local-dashboard** at `D:\UGit\-local_dashborad` is the host-level ops UI (`http://127.0.0.1:9780`). Kuroneko dev services are registered under page **`kuroneko`**.

## 和 Dashboard（5173）有什么区别？

| 面板 | 地址 | 干什么 |
|------|------|--------|
| **local-dashboard** | http://127.0.0.1:9780/?page=kuroneko | **启停进程**：三 Agent、chat-server、业务 Dashboard、WebChat、Ops |
| **Dashboard（业务）** | http://127.0.0.1:5173 | **看内脑/外脑状态**（只读监控），顶栏切换 Kuroneko / Shiro / Gin |
| **Ops Console** | http://127.0.0.1:7779 | **看 Agent 终端日志**（stdout） |

新增 Gin 或改了 `scripts/kuroneko-utlra.bundle.json` 后，在 **kuroneko 仓库根**执行一次同步（见下），9780 里才会出现 **Agent: Gin (8789)**。

## 一键同步（推荐）

```powershell
cd D:\kuroneko
.\scripts\sync-local-dashboard.ps1
# 自定义路径：.\scripts\sync-local-dashboard.ps1 -LocalDashboardRoot D:\你的路径\-local_dashborad
```

会复制 `scripts/kuroneko-utlra.bundle.json` + `scripts/kuroneko/*.ps1` 到 local-dashboard，并运行 `merge-kuroneko-bundle.mjs` 更新 `registry.json`。

本机 **local-dashboard**（`D:\UGit\-local_dashborad`）与仓库内 **ops-console**（`npm run dev:ops`）分工：

| 工具 | 端口 | 作用 |
|------|------|------|
| **local-dashboard** | 9780 | 全机托管：CI Docker、Kuroneko **七项**服务等（启停 + 健康 + H5 打开） |
| **ops-console UI** | 7779 | 三 Agent 实时日志（API 7777）；也可从 local-dashboard 启停 |

## 已注册服务（分组 `kuroneko`，共 7 项 Agent 相关 + 其余）

与 [`apps/ops-console/src/service-registry.ts`](../../apps/ops-console/src/service-registry.ts) 一致：

| ID | 说明 | 端口 |
|----|------|------|
| `kuroneko-agent-kuroneko` | 主 Agent | 8787 |
| `kuroneko-agent-shiro` | Shiro Agent | 8788 |
| `kuroneko-agent-gin` | Gin Agent | 8789 |
| `kuroneko-dashboard` | 业务控制台 H5 | 5173 |
| `kuroneko-chat-server` | WebChat 后端 | 8790 |
| `kuroneko-web-chat` | WebChat 前端 | 5180（Vite 须监听 `127.0.0.1`，勿仅用 `::1`） |
| `kuroneko-ops-console` | **Ops 日志台**（双 Agent stdout） | 7779（API 7777） |

启停脚本：`scripts/local-dashboard/{start,stop,health}.ps1`（默认仓库根 `D:\kuroneko`，可用环境变量 `KURONEKO_ROOT` 覆盖）。local-dashboard 薄包装：`D:\UGit\-local_dashborad\scripts\kuroneko\*.ps1`。

## 手动合并（未用 sync 脚本时）

```powershell
cd D:\UGit\-local_dashborad
# 先把 kuroneko 仓库里的 bundle + scripts/kuroneko 复制过来，再：
node scripts/merge-kuroneko-bundle.mjs
```

权威源在 kuroneko 仓库：[`scripts/kuroneko-utlra.bundle.json`](../../scripts/kuroneko-utlra.bundle.json)、[`scripts/kuroneko/`](../../scripts/kuroneko/)。

## 打开仪表盘

```powershell
cd D:\UGit\-local_dashborad
.\start.ps1
# 浏览器 http://127.0.0.1:9780/?page=kuroneko
```

## 三 Agent 的实时日志（Ops Console）

在 **local-dashboard** 的 `kuroneko` 页启动 **`Ops Console (7779)`**，或仓库根 `npm run dev:ops`。

浏览器 **http://127.0.0.1:7779/** → Kuroneko / Shiro / **Gin** 卡片点 **「查看日志」**（约 2s 轮询，最多 1000 行）。

> Ops 只**展示**日志；Agent 进程在 **9780** 的 `kuroneko` 页启停（`kuroneko-agent-*`），或在 ops-console 内启停。

| Agent | 端口 | 环境文件 |
|-------|------|----------|
| Kuroneko | 8787 | `.env` |
| Shiro | 8788 | `.env.agent2` |
| Gin | 8789 | `.env.gin` |
