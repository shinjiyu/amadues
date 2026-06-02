# DyFlow 节点提升（Creator pack）调优

> **状态**：待调优（2026-06-02，bot2 首跑观测）  
> **关联 ADL**：[`DYFLOW-INNER-EXECUTOR.md`](../structurizr/DYFLOW-INNER-EXECUTOR.md) §7–8、[`INNER-NODE-LIFECYCLE.md`](../structurizr/INNER-NODE-LIFECYCLE.md)

---

## 1. 现象（bot2 / `ib-mpwfiv02-2887`）

- ~6.4M tokens、5+ 轮 DESIGN↔RUN，**战术自愈很好**（含执行器自发 Playwright → Designer 采纳）。
- **`preset/node_creator` 从未入 DAG**：`local_nodes/` 仅 3 个 preset，无 `local/*`；pi-mono 日志 `ref` 全是 `preset/base`。
- 已成功节点（n1 凭据、n2 调研、n4 依赖、n5 写脚本、n7 API、n10 Playwright 探测等）**未 pack**，每轮 Designer 仍写长 instruction 重跑同类 baseNode。

结论：**P0/P1 能力在，Designer 策略未触发「提升」**——可能非常需要调优。

---

## 2. 「节点提升」指什么

| 步骤 | 机制 |
|------|------|
| pack | Designer 排 `ref=preset/node_creator`，`params.mode=pack`，`source_node_ids=[…]` |
| 落盘 | `commit_local_node` → `.brain/local_nodes/local/<name>.json` |
| 共享 | P1：`autoExport` → drive9；下轮 `search_and_instance` |

当前 `designer.ts` 仅为**可选**提示（「需要固化成功战术时**可**排 node_creator」），无硬性触发条件。

---

## 3. 调优方向（待做）

1. **Designer prompt / 工具引导**
   - RUN 一轮结束后，若 `node_results` 有稳定 `ok:true` 且模式可复述 → 下一轮 DAG **必须或优先**含 1 个 pack 节点。
   - 救火场景（连续 `last_failure`）可豁免，避免与 replan 抢 token。

2. **触发启发式（可选，env 可关）**
   - 同一类 instruction 第 2 次出现且前次 `ok` → 建议 pack 为 `local/…`。
   - `n2_research_ps` 类「调研」成功后默认 pack + `extract_facts` 分工。

3. **观测**
   - RunReport / `task-run-observability` 增字段：`creatorRuns`、`localNodesCreated`、`drive9Exports`。
   - bot2 类任务对比：有/无 pack 的 token 与轮次。

4. **与 cap 联动**
   - baseNode 50 轮 cap 浪费时，更应在**成功小节点**上 pack，减少重复 ReAct（见另议降低 `SAFETY_MAX_ROUNDS`）。

5. **先判 Tool 再判 Node**（重要修正，2026-06-02）
   - bot2 复盘：多数「应提升」项（查 ELO、跑脚本、Playwright 登录）其实是 **Tool**（一次调用），不是 LocalNode。
   - 晋升前先按 [`dyflow-tool-promotion.md`](./dyflow-tool-promotion.md) / ADL §7b 判定：步骤固定无分支 → **Tool（T0 `register_workspace_script_tool`）**；仍需临场判断 → 才 pack 成 LocalNode。

---

## 4. 验收（调优完成后）

- [ ] 至少一次 burst 内出现 `module=node-creator` 或 pi-mono `ref=preset/node_creator` 且 `commit_local_node` 成功。
- [ ] `local_nodes/index.json` 出现 `local/<语义名>`（非仅 preset）。
- [ ] 后续 DESIGN 使用 `search_and_instance` 或 `ref: local/…`，同类子目标 token 明显下降。

---

## 5. 参考

- 首跑 workspace：`packages/server/data-bot2/workspaces/task-ib-mpwfiv02-2887/`
- 实现：`packages/server/src/openkuroneko/inner-brain/designer.ts`、`node-creator-executor.ts`、`preset-nodes.ts`
