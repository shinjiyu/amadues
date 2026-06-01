# mem9 / drive9 密钥申请与配置

Amadues 外脑默认把**对话日志、任务记录**写入 [mem9](https://mem9.ai/)，把**技能 / 知识 Markdown** 写入 [drive9](https://drive9.ai/)。两者均为 **PingCAP 同厂托管服务**，需各自申请 API Key 后填入 Agent 环境变量。

> 未配置时 Agent 仍可启动，但语义记忆与云端技能库会降级为本地-only（见 [data-layer-phase1-draft.md §14](../data-layer-phase1-draft.md#14-云端记忆层落地2026-04-08-实际实现)）。

---

## 1. 在 Amadues 里填哪里

| 变量 | 用途 | 必填 |
|------|------|------|
| `MEM9_API_KEY` | mem9 租户 / 记忆空间 | 推荐（外脑 daily-log、tasks） |
| `DRIVE9_API_KEY` | drive9 文件系统 | 推荐（技能 grep、知识原文） |
| `DRIVE9_SERVER` | API 基址 | 否，默认 `https://api.drive9.ai` |

模板见：

- [`deploy/agent/env/agent.env.example`](../../deploy/agent/env/agent.env.example)
- 各实例 `deploy/agent/env/<instance>.env.example`（如 `gin.env.example`）

**不要**把真实 Key 提交 Git；只提交 `.env.example` 占位。

---

## 2. mem9 — 申请 API Key

**产品主页：** https://mem9.ai/  
**官方文档：** https://mem9.ai/docs/  
**HTTP API 参考：** https://mem9.ai/api/

### 方式 A：OpenClaw / 插件一键（推荐给非自研集成）

在支持 OpenClaw 的环境里，让 Agent 执行官方 onboarding（会自动安装并签发 Key）：

```text
Read https://mem9.ai/SKILL.md and follow the instructions to install and configure mem9 for OpenClaw
```

完整说明见：https://mem9.ai/SKILL.md

### 方式 B：自研 / curl 开通（Amadues 直连）

无需登录页时，可直接 **POST 开通** 一个新记忆空间，响应里的 `id` 即为 `MEM9_API_KEY`：

```bash
curl -sX POST https://api.mem9.ai/v1alpha1/mem9s
# => {"id":"<your-mem9-api-key>"}
```

后续请求使用：

- Header：`X-API-Key: <MEM9_API_KEY>`
- 业务 API 基址：`https://api.mem9.ai/v1alpha2/mem9s/...`

Amadues 实现见 `packages/server/src/mem9/mem9-client.ts`（外脑按 `agentSid:chat` / `agentSid:tasks` 命名空间隔离）。

**控制台：** 开通后可在 https://mem9.ai/ 的 **Your Memory** 查看已写入记忆（需用同一 Key 登录/绑定）。

---

## 3. drive9 — 申请 API Key

**产品主页：** https://drive9.ai/  
**Agent 安装说明：** https://drive9.ai/skill.md

### 方式 A：按 skill.md 安装（官方推荐）

让 Agent 阅读并执行：

```text
Read https://drive9.ai/skill.md and follow the instructions to install and configure drive9
```

或本机脚本（会引导配置 `DRIVE9_API_KEY`，格式通常为 `dat9_...`）：

```bash
curl -fsSL https://drive9.ai/install.sh | sh
```

### 方式 B：已有 Key 时

将 Key 写入环境变量：

```bash
export DRIVE9_API_KEY="dat9_..."
export DRIVE9_SERVER="https://api.drive9.ai"   # 可选，默认即此
```

Amadues 通过 `Authorization: Bearer` 访问 `GET/PUT /v1/fs/{path}` 与 `?grep=` 语义搜索，见 `packages/server/src/drive9/drive9-client.ts`。

**本地浏览技能库（可选）：** [`tools/drive9-explorer/README.md`](../../tools/drive9-explorer/README.md)

---

## 4. 验收

配置并重启 Agent 后：

```bash
curl -fsS "http://127.0.0.1:<agent-port>/api/health"
# 期望 ok: true

# 可选：drive9 连通（需 DRIVE9_API_KEY）
curl -fsS -H "Authorization: Bearer $DRIVE9_API_KEY" \
  "https://api.drive9.ai/v1/fs/skills/shared/?list=1"
```

若 Key 无效，日志中会出现 mem9 / drive9 HTTP 401；外脑会跳过云端写入，不影响 `/api/health`。

---

## 5. 相关文档

| 文档 | 内容 |
|------|------|
| [agent-quickstart.md](./agent-quickstart.md) | Docker 部署与 env 总表 |
| [data-layer-phase1-draft.md §14](../data-layer-phase1-draft.md#14-云端记忆层落地2026-04-08-实际实现) | 双层架构与降级链 |
| [MEMORY-STORAGE-BOUNDARY.md](../structurizr/MEMORY-STORAGE-BOUNDARY.md) | mem9 / drive9 / 本地边界（ADL） |
