# 跨 Agent 研究共享 + 钥匙串（设计待实现）

> **English:** Shiro→Kuroneko research reuse = **inner brain distills `write_skill`** (drive9 `/skills/shared/`), prompted automatically—not memory blocks or a separate research vault. Keychain stays a **kv_secret memory block** (future).

**状态**：B2 ✅ keychain · **R1+R2** ✅ Attributor write_skill 门控 + 重试/BLOCK 兜底 · R3 ⏳ Dashboard

关联：[`MEMORY-STORAGE-BOUNDARY.md`](../structurizr/MEMORY-STORAGE-BOUNDARY.md) · [`attributor.ts`](../../packages/server/src/openkuroneko/controller/attributor.ts) · [`executor-resolved-pendings-truncation.md`](./executor-resolved-pendings-truncation.md)（600 字截断专篇）· [`memory-belief-reconciliation.md`](./memory-belief-reconciliation.md)

---

## 问题 1：Shiro 研究 → Kuroneko 复用

### 原则（与块记忆、research 目录无关）

| 做什么 | 用什么 | 不做什么 |
|--------|--------|----------|
| 可复用研究结论、方法、避坑 | 内脑 **Attributor `write_skill`** → drive9 `/skills/shared/` | ❌ Memory Block / `/research/shared/` 作为主通道 |
| 完整报告、原始 MD | 留在 **workDir 交付物**；skill 里只写摘要 + 相对路径 | ❌ 群聊贴全文、❌ mem9 `write_memo` 塞 30k 字 |
| Kuroneko 消费 | 已有 `seedRelevantSkillsFromDrive9(goal)` | ❌ 再建 `seedRelevantResearchFromDrive9` |

**核心**：共享 = **技能库里的蒸馏条目**，由提示词在归因阶段**强制促成**，不是外脑搬运文件。

### 现状（为何不好用）

| 通道 | 实际行为 | 问题 |
|------|----------|------|
| 群聊发 MD | Shiro 外脑 `reply_to_user` 贴大量文件 | Kuroneko 不读 thread；易超 IM |
| `write_skill` | Attributor 专用，门槛高（≥3 步、禁单步） | **研究类里程碑很少触发写入** |
| `write_memo` | mem9 `:tasks` | 召回差，不适合结构化研究 |
| 块记忆 / research vault | （曾讨论） | 与 skill 池重复，且 LLM 不会主动 CRUD「研究块」 |

### 目标体验

1. 用户对 **Shiro** 下研究 KPI（如「WAF 绕过调研」）。
2. Executor 在 workDir 产出报告文件；**Attributor 结束前至少 1 次 `write_skill`**，把结论压成可复用技能（含 tags、附件路径）。
3. 用户对 **Kuroneko** 下执行 KPI → `set_goal` 时 `seedRelevantSkillsFromDrive9` 自动注入相关技能索引；Executor 用 `get_skill_content` 按需展开。

### 研究类 skill 内容格式（`write_skill`）

`category` 建议 `web` 或 `general`；`tags` **必须**含主题关键词 + `research` + 源 agent（如 `shiro`）。

```markdown
场景：<本研究回答什么问题，不含具体 burst 路径>

结论摘要：
  - <要点 1>
  - <要点 2>

方法 / 步骤：
  1. <可复用步骤>
  2. …

验证：<如何确认结论仍成立>

附件（按需 read_file，禁止整份写入 skill）：
  - <相对 workDir 路径，如 reports/waf-bypass.md>
```

单条 skill 控制在 **可检索、可注入** 的规模（约 1–3k 字）；长文只留路径。

### 提示词自动促成（P0，无新工具）

三层叠加，让 Attributor **默认会写**，而不是靠外脑记得调工具。

#### 1）里程碑契约（Decomposer / 人工 KPI）

在 `milestones.md` 的 `> 必交付物` 或 `> 跨Agent共享` 行写明，例如：

```text
> 必交付物：workDir 内研究报告；归因阶段至少 1 条 write_skill（tags 含 waf, research, shiro）
> 跨Agent共享：须 write_skill 蒸馏，禁止在 IM 贴全文
```

`formatMilestoneContractForPrompt` 已会把 `必交付物` 注入 Executor / Attributor。

#### 2）Attributor 系统提示（`ATTRIBUTOR_SYSTEM`）— 研究分支

在现有「任务 3 — 技能提取」决策树**之前**增加研究类例外（实现时改 `attributor.ts`）：

- 若契约含 `write_skill` / `跨Agent` / `研究` / `蒸馏`，或里程碑标题含「调研/研究」：
  - **SUCCESS_AND_NEXT 或 CYCLE_DONE 前**：至少调用 **1 次** `write_skill`（可多条，按子主题拆分）。
  - **放宽**「≥3 步机械操作」门槛；改为要求「结论摘要 + 可复用方法 + 验证」。
  - **禁止**把整份报告正文 paste 进 `content`；用「附件」段列相对路径。
  - 若已有相似 skill（索引命中）→ **merge 更新**（`write_skill` 已支持 merged），补充新结论而非跳过。
- 若研究里程碑结束但 **未** 调用 `write_skill` → 倾向 **CONTINUE**（`REASON`: 须先完成技能蒸馏），不要 SUCCESS_AND_NEXT。

#### 3）框架兜底（P1，可选）

- burst 结束解析 Attributor tool log：契约要求 `write_skill` 但本轮 0 次 → 外脑 **BLOCK** 或自动再跑一轮仅-Attributor（带「你漏了 write_skill」）。
- 外脑 soul / 研究 KPI 模板一句：**「交付 = workDir 文件 + 内脑 skill，群聊只许一行摘要。」**

**不做**：`publish_shared_research`、DONE 自动上传 `/research/shared/`（除非日后 skill 仍不够用时再议）。

### Kuroneko 读取（已有，无需新路径）

`outer-tools.ts` → `execSetGoal`：

```text
seedRelevantSkillsFromDrive9(goal)   // 已有
```

### 验收

- [x] Attributor 研究里程碑：专用 prompt + 缺 write_skill 时 SUCCESS→CONTINUE 门控（R1）
- [x] 契约要求 write_skill 但 0 次：Attributor 重试 pass → 仍缺则 BLOCK 通知外脑（R2）
- [ ] 研究类 burst 结束后，drive9 `/skills/shared/` 新增或 merge 含对应 tags 的条目（运行时验收）
- [ ] Kuroneko 同主题 `set_goal` 后，`.brain/skills.md` 索引含该条，`get_skill_content` 可读
- [ ] 群聊不再用 >20 个 MD 附件代替共享
- [ ] Attributor 日志中研究里程碑可见 `write_skill` 调用

---

## 问题 2：钥匙串（Keychain）

> **架构归属**：钥匙串 = Memory Block 框架下首个 **`block_id=keychain`**、**`strategy=kv_secret`**。通用分块、CRUD 工具见 [`memory-blocks-framework.md`](./memory-blocks-framework.md)。下文为首批落地的字段与 bind 约定。

### 原则

| 原则 | 说明 |
|------|------|
| **与 mem9 分离** | Cookie/Token **禁止** `ingest(mode:smart)`、禁止 `write_memo` 全文 |
| **与 chat 分离** | 用户粘贴 Cookie 不进 thread 长期存储（可仅存 ref） |
| **按引用注入** | 内脑只见 `workDir/.brain/secrets/<slot>.json`（`.gitignore`） |
| **可轮换** | 同 slot 覆盖写；记录 `updated_at`、来源 thread |
| **可审计** | 日志只打 `slot` 名 + 长度，不打 value |

### 存储选型

| 方案 | 路径 | 适用 |
|------|------|------|
| **A（推荐）** | drive9 `/vault/keychain/{agentSid}/{slot}.json` | 多机一致；与现有 drive9 一致 |
| B | 本地 `DATA_ROOT/vault/keychain.json` | 无 drive9 时降级；不跨机 |

**slot 命名**：`weibo`、`github`、`cnki` 等；`global` 仅当明确共享。

**文件格式**（Cookie Editor JSON 或 header 串均可，原样存储）：

```json
{
  "slot": "weibo",
  "kind": "cookie_header",
  "value": "SUB=...; SUBP=...",
  "updated_at": "2026-05-27T14:02:25Z",
  "updated_by": "human:webchat:global",
  "notes": "shinji-kuroneko, 含 WBPSESS"
}
```

### API / 工具面

**外脑**（Gin/Kuroneko/Shiro 均可；实现时优先统一为 `memory_block_*`，见 [`memory-blocks-framework.md`](./memory-blocks-framework.md)）：

| 工具（目标名） | 作用 |
|----------------|------|
| `memory_block_put` (`keychain`, key=`slot`) | `value` + `kind` → vault |
| `memory_block_entries` (`keychain`) | slot 列表（无 value） |
| `memory_block_bind` (`keychain`, keys, `instance_id`) | → `workDir/.brain/secrets/{slot}.json` |

过渡期可保留 `keychain_*` 别名指向同一 store。

**内脑**：

- 只读 `read_file(".brain/secrets/weibo.json")`；**禁止** `write_knowledge` 写完整 Cookie。
- `constraints.md` 自动追加：`[钥匙串] 使用 .brain/secrets/ 下文件，勿 echo 到日志/群聊`。

**用户 IM 粘贴 Cookie 时**（Gin 案例修复）：

```text
awaitingInboundResolver / 外脑
  → memory_block_put(keychain, key=weibo, value=...)
  → memory_block_bind(keychain, [weibo], instance_id)
  → send_directive 仅写：「已写入钥匙串 slot=weibo，请读 .brain/secrets/weibo.json」
```

**不再**把 4k 字 JSON 塞进 `send_directive`；resolve 后走钥匙串或 pending spill（见 [`executor-resolved-pendings-truncation.md`](./executor-resolved-pendings-truncation.md)）。

### 与「公共记忆」边界

| 内容 | 进钥匙串 | 进 shared research | 进 mem9 |
|------|----------|-------------------|---------|
| 微博 Cookie | ✅ | ❌ | ❌ |
| API Key | ✅ | ❌ | ❌ |
| WAF 研究报告 | ❌ | ❌（→ `write_skill`） | 摘要一句可选 |
| 任务进度 | ❌ | ❌ | ✅ tasks/dailyLog |

### 安全（MVP）

- drive9 路径 ACL 沿用现有 key；文档注明勿提交 vault 到 git。
- 后续：加密 at rest（`KEYCHAIN_MASTER_KEY`）、slot 级 ACL（仅 kuroneko 可读 `weibo`）。

### 验收

- [x] 用户贴 Cookie → `memory_block_put` / IM resolve → 内脑 `read_file(.brain/secrets/…)` 得完整 SUB
- [x] executor `credential_ref` 内联路径，不再 spill 假截断
- [ ] mem9 中搜不到 Cookie 明文（需运行时验收）

---

## 实现梯度（建议顺序）

| 阶段 | 交付 |
|------|------|
| **P0** | [`executor-resolved-pendings-truncation.md`](./executor-resolved-pendings-truncation.md) — resolved pending spill，去掉 600 字硬截断 |
| **B1** | Memory Block 框架 + `kv_secret` / `keychain`（见 [`memory-blocks-framework.md`](./memory-blocks-framework.md)） |
| **R1** | Attributor 研究分支 + write_skill 门控 | ✅ |
| **R2** | Attributor 重试 pass + 仍缺则 BLOCK | ✅ |
| **R3** | Dashboard 钥匙串管理页（可选） | ⏳ |

---

## 修订

| 日期 | 说明 |
|------|------|
| 2026-05-27 | 初稿：跨 Agent 研究共享路径 + 钥匙串与 mem9 分离 |
