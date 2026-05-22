# 注册到 local-dashboard / Register with local-dashboard

> **English:** **local-dashboard** at `D:\UGit\-local_dashborad` is the host-level ops UI (`http://127.0.0.1:9780`). Kuroneko dev services are registered under page **`kuroneko`**.

本机 **local-dashboard**（`D:\UGit\-local_dashborad`）与仓库内 **ops-console**（`npm run dev:ops`）分工：

| 工具 | 端口 | 作用 |
|------|------|------|
| **local-dashboard** | 9780 | 全机托管：CI Docker、Kuroneko **六项**服务等（启停 + 健康 + H5 打开） |
| **ops-console UI** | 7779 | 双 Agent 实时日志（API 7777）；也可从 local-dashboard 启停 |

## 已注册服务（分组 `kuroneko`，共 6 项）

与 [`apps/ops-console/src/service-registry.ts`](../../apps/ops-console/src/service-registry.ts) 一致：

| ID | 说明 | 端口 |
|----|------|------|
| `kuroneko-agent-kuroneko` | 主 Agent | 8787 |
| `kuroneko-agent-shiro` | Shiro Agent | 8788 |
| `kuroneko-dashboard` | 业务控制台 H5 | 5173 |
| `kuroneko-chat-server` | WebChat 后端 | 8790 |
| `kuroneko-web-chat` | WebChat 前端 | 5180（Vite 须监听 `127.0.0.1`，勿仅用 `::1`） |
| `kuroneko-ops-console` | **Ops 日志台**（双 Agent stdout） | 7779（API 7777） |

启停脚本：`scripts/local-dashboard/{start,stop,health}.ps1`（默认仓库根 `D:\kuroneko`，可用环境变量 `KURONEKO_ROOT` 覆盖）。local-dashboard 薄包装：`D:\UGit\-local_dashborad\scripts\kuroneko\*.ps1`。

## 重新合并注册表

在 **local-dashboard** 仓库根目录：

```powershell
cd D:\UGit\-local_dashborad
node scripts/merge-kuroneko-bundle.mjs
```

源定义（两份同步）：`D:\UGit\-local_dashborad\scripts\kuroneko-utlra.bundle.json` 与仓库内 [`scripts/kuroneko-utlra.bundle.json`](../../scripts/kuroneko-utlra.bundle.json)；薄包装：`scripts/kuroneko/*.ps1`。

## 打开仪表盘

```powershell
cd D:\UGit\-local_dashborad
.\start.ps1
# 浏览器 http://127.0.0.1:9780/?page=kuroneko
```

## 两个 Agent 的实时日志（Ops Console）

在 **local-dashboard** 的 `kuroneko` 页启动 **`Ops Console (7779)`**，或仓库根 `npm run dev:ops`。

浏览器 **http://127.0.0.1:7779/** → `Agent: Kuroneko` / `Agent: Shiro` 卡片点 **「查看日志」**（约 2s 轮询，最多 1000 行）。

> Ops 只**展示**日志；Agent 进程仍由 `kuroneko-agent-kuroneko` / `kuroneko-agent-shiro` 启停（或 ops-console 内也可启停，与 local-dashboard 二选一即可）。

| Agent | 端口 | 环境文件 |
|-------|------|----------|
| Kuroneko | 8787 | `.env` |
| Shiro | 8788 | `.env.agent2` |
