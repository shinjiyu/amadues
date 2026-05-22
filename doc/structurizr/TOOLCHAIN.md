# Structurizr vNext 工具链（Kuroneko 试验目录）

本目录存放 [`workspace.dsl`](./workspace.dsl)（**ADL 权威**：L1/L2/L3 + 视界属性）。重构计划见 [`REFACTOR-PLAN.md`](./REFACTOR-PLAN.md)，模块契约见 [`modules-catalog.md`](./modules-catalog.md)。与 [`../architecture.md`](../architecture.md) 的 Mermaid 图互补：Structurizr 负责**命名容器、关系类型标签、可导出视图**；Mermaid 仍保留实现级数据流细节。

## 前置条件

| 方式 | 要求 |
|------|------|
| **Java .war（本机已通）** | Java 21+；`./run-war.ps1`（war 在 `.tools/`，约 212MB，已 gitignore） |
| **Docker** | `structurizr/structurizr` 镜像；若 Docker Hub 超时则用 war 方案 |
| **社区包** | 如 `scoop install structurizr-cli`（第三方维护，可能仍是旧 CLI） |

本机 2026-05-18：`docker pull structurizr/structurizr` 因访问 `production.cloudflare.docker.com` 超时失败；`download.structurizr.com` 可下 war，已装 Temurin 21。

官方说明：[Binaries](https://docs.structurizr.com/binaries) · [Commands](https://docs.structurizr.com/commands)

## 在仓库根目录用 Docker 运行

PowerShell（工作目录 = 本文件夹）：

```powershell
cd doc/structurizr
$mount = (Get-Location).Path -replace '\\','/'
docker pull structurizr/structurizr
docker run --rm -v "${mount}:/usr/local/structurizr" -w /usr/local/structurizr structurizr/structurizr <command> [args]
```

### 用 cmd（推荐，无需 PowerShell）

在资源管理器地址栏输入 `cmd` 回车，或「Win+R → cmd」：

```bat
cd /d d:\kuroneko\doc\structurizr

validate.bat          REM 校验 workspace.dsl
inspect.bat           REM 模型 lint（缺 description 等）
deps-check.bat        REM 代码 import 国境（dependency-cruiser ← DSL）

仓库根目录一键（DSL + 代码国境）：

```bat
cd /d d:\kuroneko
npm run structurizr:check
```

**CI**：push/PR 到 `main` 时 GitHub Actions 跑 `structurizr:check`（无本地 war 时会从 `download.structurizr.com` 拉取，约 212MB）。
list.bat              REM 列出元素
export-mermaid.bat    REM 生成 structurizr-*.mmd
export-plantuml.bat   REM 生成 structurizr-*.puml
local.bat             REM 浏览器看图 http://localhost:8080（必须带数据目录，见 local.bat）

REM 任意子命令：
run-war.bat inspect -workspace workspace.dsl
run-war.bat help
```

也可双击 `local.bat` / `validate.bat`（会开 cmd 窗口）。

## 代码 → DSL 与 diff（本仓库扩展）

Structurizr 官方**不提供**从 TypeScript 反推 DSL。本仓库用 Node 脚本 + Cursor Skill：

| 命令 | 作用 |
|------|------|
| `npm run structurizr:generate -- --granularity l2-imports` | 从 `manifest.mjs` + `package.json` 生成 DSL |
| `npm run structurizr:generate -- --list` | 列出粒度预设（防漂移，必须显式指定） |
| `npm run structurizr:diff -- --left A.dsl --right B.dsl` | 对比两 workspace（解析 `!include`） |

- 输出默认：`generated/workspace.generated.dsl`（已 gitignore）
- 粒度：`l1` / `l2` / `l2-imports` / `l3-outer` / `l3-inner` / `l3-full` — 见 `scripts/structurizr/manifest.mjs`
- Agent 指引：`.cursor/skills/structurizr-codegen/SKILL.md`
- **不要**用生成文件直接覆盖 `workspace.dsl`（视界属性、视图、L2 路径边需人工合并）

### 用 PowerShell（可选）

```powershell
./run-war.ps1 validate
./run-war.ps1 local
```

## vNext 可用命令一览（开源免费部分）

| 命令 | 用途 |
|------|------|
| **local** | 本地浏览器查看/拖拽布局（原 Lite）；默认读 `workspace.dsl` |
| **playground** | 在线式 DSL 试验场 |
| **export** | 导出 PlantUML、Mermaid、静态 HTML 等 |
| **validate** | 校验 DSL / JSON 工作区 |
| **inspect** | 对工作区运行 inspections |
| **（本仓库）structurizr:deps** | `dependency-cruiser` + [`deps.rules.cjs`](./deps.rules.cjs) |
| **list** | 列出模型中的元素 |
| **merge** | 合并布局信息到工作区 |
| **push** / **pull** | 与 Structurizr **server** 同步（需自建或使用云服务） |
| **branches** / **create** / **delete** / **lock** / **unlock** | 服务端工作区管理 |
| **version** / **help** | 版本与帮助 |

需商业许可：**server**（团队发布、协作）。见 [local vs server](https://docs.structurizr.com/local)。

## 关系标签约定（本模型）

| 标签 | 含义 | 示例边 |
|------|------|--------|
| `http` | HTTP(S) API | agentServer → llm |
| `ws` | WebSocket | discord → discordBridge |
| `spawn` | 子进程启动 | agentServer → innerWorker |
| `file` | 共享 workDir / status.json | innerWorker → agentServer |
| `import` | 同 monorepo 内模块调用 | discordBridge → agentServer |

## 导出产物

`./run.ps1 export` 默认在当前目录生成 `plantuml/`（可用 `-format mermaid` 等）。PNG/SVG 需 **playwright** 版镜像：`structurizr/structurizr:2026.05.16-playwright`。

## 与代码同步

- 容器 `properties.path` 指向 monorepo 路径，**不会自动扫描 TypeScript**；改架构时手工更新 DSL。
- 详细模块表仍以 `doc/architecture.md` 为准；本 DSL 聚焦 C4 边界与集成类型。
