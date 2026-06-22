# 内脑节点技能（Node Skills）

> **English:** Reusable **skills bind to LocalNode**, not only global `.brain/skills/`. Attributor distills skills after RUN; Runner loads them before baseNode execution; promote / Abstractor / Assembler carry the bundle.

> **配套**：[`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) · [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md) · [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md)

> **状态**：2026-06-08 定稿 · 实现于 `inner-brain/node-skill-store.ts` 等

---

## 1. 动机

| 现象 | 根因 |
|------|------|
| 同一战术重复现场摸索 | LocalNode 只有 prompt，缺少可复用「操作模式」层 |
| 全局 skills 与节点脱节 | seed 时按 goal 检索，与具体 ref 无关 |
| promote 丢技能 | 提升只固化 promptTemplate，归因产出的技能未绑定 |

节点技能 = **与 LocalNode id 绑定的可复用步骤**，随节点提升 / 实例化 / 共享。

---

## 2. 三个概念

| | 形态 | 存储 | 何时产生 |
|--|------|------|---------|
| **NodeSkillRef** | 索引条目 `{ id, category, title, tags? }` | `LocalNode.skills[]` | Attributor `record_skill` / promote 拷贝 / Assembler 装配 |
| **NodeSkill 正文** | Markdown 步骤 | `.brain/local_nodes/skills/<encodedId>/<category>/<id>.md` | 同上 |
| **NodeDefSkill** | 脱敏后的 `{ ...ref, content }` | `NodeDef.skills[]`（drive9 共享） | Abstractor export |

`encodedId` = LocalNode id 中 `/` → `__`（如 `local/ps_open` → `local__ps_open`）。

---

## 3. 四条不变量

| ID | 不变量 | 说明 |
|----|--------|------|
| **S1** | **Attributor 负责蒸馏 skills** | RUN 后 Mandatory Attributor 调 `record_skill`，绑定 `nodeRef` |
| **S2** | **执行前加载 skills** | Runner 派发 baseNode 前：`nodeSkillLoader` 读绑定技能 + 可选全局检索，注入 system prompt |
| **S3** | **提升携带 skills** | `promote_local_node` 从 `sourceRef` 拷贝技能到新 LocalNode |
| **S4** | **实例化携带 skills** | Assembler 把 `NodeDef.skills[]` 写入 imported LocalNode 技能目录 |

---

## 4. Attributor：`record_skill`

| 项 | 值 |
|----|-----|
| 模块 | `inner-brain/node-skill-tools.ts` |
| 工具 | `record_skill`（仅 ATTRIBUTE 阶段） |
| 参数 | `nodeRef`, `category`, `title`, `tags?`, `content` |
| 输出 | 写技能文件 + 更新 `LocalNode.skills[]`（去重 by id） |

任务顺序（追加到 [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md) §4 prompt）：

1. 事实 → `record_fact`
2. 红线 → `record_constraint`
3. **可复用操作步骤**（Playwright 序列、脚本模式、API 调用链）→ `record_skill`（必须指定 `nodeRef`）

---

## 5. Runner：执行前加载

```text
dispatchNode(inst, node):
  skillsSection ← loadNodeSkills({ node, inst, workDir, skillProvider? })
  runBaseNode({ ..., skillsSection })
```

`loadNodeSkills` 逻辑：

1. 读 `node.skills[]` + 技能目录正文（绑定技能，优先）
2. 若注入 `SkillProvider`：按 `description + tags + instruction` 检索 topK（默认 3），合并去重
3. 拼 `## 节点技能（执行前加载）` 块追加到 baseNode system prompt

---

## 6. promote_local_node

入参新增可选 `sourceRef`（源 LocalNode id，如 `preset/base`）。

```text
promote_local_node({ id, ..., sourceRef? })
  → commit LocalNode
  → 若 sourceRef：copyNodeSkills(sourceRef → newId)
  → fire-and-forget abstractLocalNode（含 skills 导出）
```

---

## 7. Abstractor / Assembler

**Export**（LocalNode → NodeDef）：

- 读源节点技能目录，嵌入 `NodeDef.skills[]`（含 content）
- dedupeKey **不含** skills（body+interface 不变）

**Import**（NodeDef → imported LocalNode）：

- 写 `NodeDef.skills[]` 到 `.brain/local_nodes/skills/<importedId>/`
- 设置 `LocalNode.skills[]` refs

---

## 8. ADL 组件

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| **nodeSkillStore** | `inner-brain/node-skill-store.ts` | 节点技能读写 / 拷贝 / 绑定 LocalNode |
| **nodeSkillLoader** | `inner-brain/node-skill-loader.ts` | 执行前加载 + prompt 块 |
| **nodeSkillTools** | `inner-brain/node-skill-tools.ts` | Attributor `record_skill` |

---

## 9. 测试

| 类型 | 文件 |
|------|------|
| 单元 | `node-skill-store.test.ts`, `node-skill-loader.test.ts`, `attributor.test.ts`（record_skill） |
| 组件 | ⏳ promote 携带 skills |

---

## 10. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-06-08 | 初版：节点绑定技能；Attributor 蒸馏；Runner 加载；promote/Assembler 携带 |
