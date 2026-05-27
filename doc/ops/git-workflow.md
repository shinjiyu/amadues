# Git 工作流（Windows）/ Git workflow (Windows)

> 本仓库在 Windows 开发机上统一使用 **`hutao`**（`D:\tools\Hutao\cmd\hutao.cmd`）代替原生 `git`，以避免 `git push` 被环境拦截。  
> On this workstation, use **`hutao`** instead of plain `git` for all commands (especially push).

---

## 日常命令 / Daily commands

```powershell
cd D:\kuroneko

hutao status
hutao diff --stat HEAD
hutao log --oneline -10

hutao add <paths>
hutao commit -F .tool-outputs\commit-msg.txt   # 多行说明用文件，避免 PowerShell heredoc 问题

hutao fetch origin
hutao pull origin main
```

---

## 推送 / Push

### 方式 A：凭据管理器（推荐长期）

修好 [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager) 后：

```powershell
hutao push origin main
```

若出现 `gcmcore` / `FileNotFoundException`，说明 GCM 未装好，用方式 B。

### 方式 B：Personal Access Token（一次性 URL）

在 **本机终端**执行（勿把 token 提交进仓库或贴进工单）：

```powershell
hutao push "https://<GITHUB_USER>:<GITHUB_PAT>@github.com/<OWNER>/<REPO>.git" main
```

推送成功后建议在 GitHub → **Settings → Developer settings → Personal access tokens** 轮换 token。

### 同步远程引用 / Refresh `origin/main`

推送后若 `hutao status` 仍显示 `ahead`，可显式更新跟踪分支：

```powershell
hutao fetch "https://<GITHUB_USER>:<GITHUB_PAT>@github.com/<OWNER>/<REPO>.git" main:refs/remotes/origin/main
```

---

## 不要入库 / Do not commit

- `.env` / `.env.local`（已在 `.gitignore`）
- `.tool-outputs/` 测试 JSON 与日志
- `apps/chat-server/data/` 运行时聊天数据
- 含 PAT 的脚本或文档

---

## 相关 / Related

- 仓库规则：`.cursor/rules/git-use-hutao.mdc`
- 本机总运维页：**local-dashboard**（`D:\UGit\-local_dashborad`，见 [`local-dashboard.md`](./local-dashboard.md)）
