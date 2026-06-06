# DyFlow 工具晋升（Tool promotion · T0/T1/T2） — ❌ DEPRECATED（2026-06-06）

> **状态**：**已废弃 / 已移除**。T0（`register_workspace_script_tool` → `ws_*`）于 2026-06-02 实现，
> 但生产（bot2）**注册 0 次、调用 0 次**，零收益却增维护成本（注册表 / materialize / Designer 可见清单 / 路径穿越校验）。
> 2026-06-06 整层移除：`workspace-script-tools.ts` 及测试删除，runner / designer / preset 提示清理。
> 固化收成 **两层** facts(A)/LocalNode(B)；稳定脚本改用 `record_fact` 记「路径 + 怎么跑」，baseNode 继续 `shell_exec` 执行。
> 本文档保留作历史记录，**不再实施 T1/T2**。
> **关联 ADL**：[`DYFLOW-INNER-EXECUTOR.md`](../structurizr/DYFLOW-INNER-EXECUTOR.md) §7b（固化两层 + 晋升准则）· §16 修订（2026-06-06）  
> **关联**：[`dyflow-node-promotion-tuning.md`](./dyflow-node-promotion-tuning.md)（LocalNode pack，现存的唯一晋升层）

---

## 1. 动机（bot2 `ib-mpwfiv02-2887`）

9 个成功节点全是 `preset/base`，**0 提升**。复盘发现「应提升」项里**多数其实应该是 Tool（一次 function call），而不是再 pack 成会 ReAct 的 LocalNode**：

| 成功节点 | 更适合 |
|----------|--------|
| n7 查 ELO（GET users.json） | **Tool**（确定性） |
| n10 Playwright 登录探测（固定 CSS） | **Tool**（最高 ROI） |
| n5/n12/n14 写脚本 → n6/n15 跑脚本 | 写=完成；跑应是 **Tool**，非每轮 50 轮 ReAct |
| n2 调研、选择器、API 形状 | **facts**（extract_facts 已做） |
| 「据 last_failure 换格式」 | **LocalNode**（仍需判断） |

---

## 2. 三层固化（成本递减）

| 层 | 载体 | 调用 | 成本 |
|----|------|------|------|
| A 事实 | `memory.facts` / `record_fact` / `extract_facts` | 读上下文 | 读 |
| B 节点 | LocalNode（`node_creator` pack） | Designer ref，**仍 ReAct** | 中 |
| C 工具 | Tool（`ws_*` / preset TS） | **一次 tool_call** | 低 |

晋升判定见 ADL §7b。

---

## 3. T0（已实现）

- `register_workspace_script_tool`：baseNode 把 workDir 内稳定脚本声明为 `ws_<name>` 工具。
- 存储 `<workDir>/.brain/workspace-tools.json`；脚本必须在 workDir 内、已落盘；name 强制 `ws_` 前缀。
- runner 派发 baseNode 时 `materializeWorkspaceScriptTools(workDir)` 注入 allowlist（核心工具之后）。
- Designer `buildUserMessage` 增「已注册工作区工具」清单 + prompt 引导；preset/base prompt 提示晋升。
- 实现：`packages/server/src/openkuroneko/inner-brain/workspace-script-tools.ts`；测试 `workspace-script-tools.test.ts`。

---

## 4. 待办

### T1（人工审核 → preset 工具）
- [ ] 运维/Designer 把高频稳定 `ws_*`（如 `ps_query_ratings`、`ps_playwright_login`）提 PR 进 `tools/definitions/*.ts`。
- [ ] 机制：Dashboard/RunReport 标记「跨 burst 复用 ≥N 次的 ws 工具」作为 T1 候选。

### T2（真·createTool，远期）
- [ ] LLM 生成 TS 工具 + 自动测试门 + 沙箱执行 + 合并。

### 观测 / 验收
- [ ] RunReport 增字段：`wsToolsRegistered`、`wsToolCalls`、`reactRoundsSaved`（粗估）。
- [ ] bot2 类任务复跑：出现 ≥1 个 `ws_*` 注册且后续轮 `ws_*` 被调用；同类「跑脚本」节点不再 50 轮 cap。
- [ ] 与 fail-fast 5/10 联动：cap 砍「死磕」，ws 工具砍「重复发明」。

---

## 5. 与 node_creator 的分界

- `node_creator` 固化**图上的格子**（认知单元，仍 ReAct）。
- `register_workspace_script_tool` 固化 **allowlist 里的原子能力**（执行单元，一次调用）。
- 两者互补；bot2 缺的主要是后者。
