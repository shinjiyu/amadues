# Git 工作流 / Git workflow

> 常规开源协作：clone → branch → commit → push。本文补充 **Windows 凭据** 与 **勿入库** 清单。

---

## 日常命令 / Daily commands

```bash
cd <repo-root>

git status
git diff --stat HEAD
git log --oneline -10

git add <paths>
git commit -m "type(scope): summary"

git fetch origin
git pull origin main
git push origin main
```

PowerShell 多行 commit 说明可写入临时文件：`git commit -F commit-msg.txt`（勿提交该文件）。

---

## 推送 / Push

### 凭据管理器（推荐）

安装 [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager) 后：

```bash
git push origin main
```

### Personal Access Token

在 **本机终端**执行（勿把 token 提交进仓库或贴进工单）：

```bash
git push "https://<GITHUB_USER>:<GITHUB_PAT>@github.com/<OWNER>/<REPO>.git" main
```

推送成功后建议在 GitHub → **Settings → Developer settings → Personal access tokens** 轮换 token。

### Windows：`hutao` 变通（可选）

部分 Windows 环境原生 `git push` 会被拦截。若你使用项目维护者提供的 `hutao` 包装（见 `.cursor/rules/git-use-hutao.mdc`），命令与 `git` 相同，例如 `hutao push origin main`。其他开发者可忽略此项。

---

## 不要入库 / Do not commit

- `deploy/agent/env/*.env`（仅 `*.env.example` 可入库）
- 根目录 `.env` / `.env.*`（除 `*.example`）
- `.tool-outputs/` 测试 JSON 与日志
- `packages/server/data*`、`apps/chat-server/data/` 运行时数据
- 含 PAT / API Key 的脚本或文档

---

## 相关 / Related

- [`local-dashboard.md`](./local-dashboard.md) — 可选本机总控 UI
- [`agent-docker.md`](./agent-docker.md) — Agent 容器与 env 布局
