# 内脑节点生命周期：LocalNode / NodeDef / Abstractor / Assembler

> **English:** Defines the lifecycle of inner-brain reusable units. Three concepts: **LocalNode** (concrete, workDir-local), **NodeInst** (a slot inside `local_dag`), **NodeDef** (sanitized template on drive9). Two pipelines: **Abstractor** (LocalNode → NodeDef, auto on Creator commit) and **Assembler** (NodeDef + binding → new LocalNode, used by Designer tool `search_and_instance`). Eviction: dedupe + quota + cold tombstone.

> **配套**：[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md)（Designer/Runner/FSM/NodeInst schema 主篇）。

> **状态**：设计定稿（2026-06-02）· **实现**：P1 起（P0 仅本地 LocalNode + preset，无 drive9 自动 export）。

---

## 1. 三个概念（不要混用）

| | 形态 | 何处存 | 何时产生 |
|--|------|--------|---------|
| **LocalNode** | **具象** JSON：定义 + 真实路径/账号/roomId | `<workDir>/.brain/local_nodes/<id>.json` | preset seed / newNodeCreator commit / Assembler 装配 |
| **NodeInst** | local_dag 里的「图格」：`{ id, ref, instruction?, params?, memoryIn?, memoryOut? }` | `<workDir>/.brain/local_dag.json` | Designer 编排时 |
| **NodeDef** | **抽象** JSON：placeholder 替代具象值 | drive9 `/nodes/shared/defs/<id>@<version>.json` | Abstractor 自动 export（Creator commit 之后） |

**Designer 永远 ref LocalNode id**；Def 是共享层的中间形态，**运行时不直接 ref**。

---

## 2. LocalNode JSON schema

```text
LocalNode {
  id:          string                # 形如 "local/ps_open_battle"；preset/* 与 imported/* 为保留前缀
  version:     string                # semver-like：1.0.0；同 id 升版本不改 ref
  displayName: string
  description: string                # Designer 选用时看；与 Agent Skills frontmatter 同心智
  tags:        string[]              # 检索辅助（KPI 类型 / 战术域）

  interface: {
    inputs:  { key, type, placeholder? }[]      # 装配时由 binding 填
    outputs: { key, type }[]                    # 写入 memory 的键名（必须满足才 ok）
  }

  body:        BodyExecutor | BodyGraph        # 二选一
  metadata:    LocalNodeMetadata
}

BodyExecutor {                       # baseNode / preset/base
  kind: "executor"
  promptTemplate: string             # 可含 ${{ memory.x }} / ${{ params.y }} 占位
  systemSlice?:   string             # 角色/约束附加
  tools:          string[]           # baseNode allowlist
  defaultParams?: Record<string, unknown>
}

BodyGraph {                          # compound（Creator pack 产物）
  kind: "graph"
  nodes: NodeInst[]                  # 子图（≠ Designer 当前 local_dag）
  edges?: { from, to }[]             # P1 起；P0 顺序串行
  entry?: string                     # 默认 nodes[0]
  exports: { from: id.outputKey, as: string }[]   # 暴露给父图 memory 的 key
}

LocalNodeMetadata {
  origin:    "preset" | "creator" | "imported"
  sourceDef?: string                 # imported 时记 NodeDef id@version
  provenance?: {                     # creator 产物记从哪几个 baseNode/history 打包
    fromNodeInsts?: string[]
    fromBurst?: string
  }
  workDir?:  string                  # 此 LocalNode 适用的 workDir（Assembler 装配时自动写）
  createdAt: ISO8601
  updatedAt: ISO8601
}
```

**约束**：

- `body.executor.tools` 必须是当前 worker 进程可解析的工具名（无效项：commit 失败）
- `interface.outputs` 是契约：baseNode runner 检测全部 outputs 满足才 ok；缺失即 terminal failure
- `imported/*` LocalNode 不再 export（防 export → import → export 循环，见 §5.5）

---

## 3. NodeInst（图里的一格）

> 已在 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §4 定义；本节只补「params 与 LocalNode 的解析」。

```text
NodeInst.params 解析顺序（runtime）:
  1. LocalNode.body.executor.defaultParams        # 模板默认
  2. LocalNode.metadata.workDir                    # 装配时写入
  3. NodeInst.params                               # Designer 本轮覆盖
  → 形成 effective params 注入 promptTemplate (${{ params.X }})
```

`memoryIn` 默认包含：`goal`, `last_failure`, `node_results.<this.id>`（前一次同 id）。  
`memoryOut` 默认写入：`node_results.<this.id>`（含 ok/failure_summary 与 outputs）。

---

## 4. Designer Tool：`search_and_instance`

**契约**：

```text
input:
  query:         string                          # drive9 NodeDef catalog 检索
  topK?:         number                          # 默认 5（防共享库灌入）
  bindingHints?: Record<string, string>          # 可选：账号/路径线索（LLM Assembler 用）
  filterTags?:   string[]                        # 限定标签（KPI 类型）；强烈建议填写

internal:
  defs ← nodeDefDrive9Store.search(query, { topK, filterTags })
  for each def in defs:
    try Assembler(def, workDir, bindingHints) → LocalNode' or skip
  写入: .brain/local_nodes/imported/<defId>@<ver>.json（origin=imported）
  更新: localNodeStore.index

output:
  instanced:  { localId, defId, version }[]       # 仅成功
  failed?:    { defId, reason }[]                 # 用于 debug；Designer 通常忽略
```

**检索语义（`nodeDefDrive9Store.search`，2026-07-25）**：

| 规则 | 要求 |
|------|------|
| **命中才返回** | drive9 `grep` 有序命中 → 按命中序取 def；再可选 `filterTags`；再 `slice(0, topK)` |
| **禁止全库回退** | grep **空 / 失败** → 返回 `[]`，**不得**把 `index.active` 整表当作候选（否则跨 agent 共享库污染本 burst，如 Twitter 任务装配 weibo_*） |
| **默认 topK=5** | 降低单次 `search_and_instance` 批量装配噪声 |

**幂等**：同一 defId@version 已装配则跳过（不重复占位）。  
**失败包容**：装配失败不影响其他成功项；Designer 仅消费 `instanced[]`。  
**编排指引**：目标陌生时优先 `preset/base`；仅在明确需要复用共享战术时再 `search_and_instance`，query 具体 + 尽量带 `filterTags`；空 `instanced` 时勿反复模糊搜。

---

## 5. Abstractor：LocalNode → NodeDef（auto-export）

### 5.1 触发

```text
nodeCreatorExecutor 成功 commit_local_node(LocalNode L)
  →（P1+）fire-and-forget nodeAbstractor(L)
  →（P0）跳过：仅写 LocalNode，不上 drive9
```

### 5.2 LLM 推断 placeholder

```text
input:
  localNode:  LocalNode
  envSnapshot: { workDir, accountHints?, hostHints?, knownSecretsKeys? }

LLM prompt（结构化输出 JSON）:
  - 找出所有「具象值」：路径、账号、roomId、IP、host、token、随机 burst id
  - 命名 placeholder：UPPER_SNAKE，如 WORK_DIR / PS_ACCOUNT / BATTLE_ROOM
  - 输出 sanitized = LocalNode 深拷贝替换具象值为 ${{ NAME }}
  - 输出 placeholders = [{ name, kind: path|account|room|secret|other, exampleHint? }]

校验:
  - sanitized 中不得残留任何 example 字面值（fail → 不写 drive9）
  - placeholder 不得与已有 drive9 catalog 冲突命名规则
  - placeholder 数量上限（如 16），防 LLM 过度抽象
```

### 5.3 NodeDef JSON schema

```text
NodeDef {
  id:           string             # 与 LocalNode id 解耦：Abstractor 重命名（如 ps_open_battle）
  version:     string              # content hash 或 semver；同 dedupeKey 仅升 version
  description: string
  tags:        string[]
  placeholders: {
    name: string                   # 形如 WORK_DIR
    kind: "path" | "account" | "room" | "secret" | "other"
    required: boolean
    exampleHint?: string           # 装配时辅助 LLM
  }[]

  interface:   LocalNode.interface  # 同结构，不脱敏
  body:        BodyExecutor | BodyGraph  # 与 LocalNode 同结构，但字符串字段含 ${{ NAME }}

  metadata: {
    sourceAgent: string            # 哪个 agentSid 提交
    sourceLocalId: string          # 源 LocalNode id（仅 catalog 元数据，不暴露 workDir 路径）
    dedupeKey:   string            # body 结构 hash，用于去重（见 §6.1）
    citeCount:   number            # 累计被 search_and_instance 装配次数
    importCount: number            # 累计被装配成功次数（成功的子集）
    assembleFailCount: number
    createdAt:   ISO8601
    lastImportedAt?: ISO8601
    status:      "active" | "tombstone"
  }
}
```

### 5.4 catalog（drive9）

```text
drive9:/nodes/shared/
  index.json                       # 所有 NodeDef 元数据 + tags + dedupeKey + status
  defs/<id>@<version>.json         # 正文
  archive/<id>@<version>.json      # tombstone 后归档（保留审计）
```

`index.json` 由 nodeDefDrive9Store **统一维护**（写 def 时同步追加；eviction 时同步移动）。  
**不**单独搜全文：catalog tags + description embedding（P2 可加）。

### 5.5 不进 export 的来源

| origin | 行为 |
|--------|------|
| `preset` | 跳过（preset 由 worker 包内 seed，不进 drive9） |
| `imported` | 跳过（防止环；同 dedupeKey 已在 catalog） |
| `creator`（pack 或 specialize） | **export**（除非 LocalNode.metadata.export = `false`） |

---

## 6. Assembler：NodeDef → LocalNode

```text
input:
  def:           NodeDef
  workDir:       string
  bindingHints?: Record<string, string>

LLM 步骤:
  - 读 def.placeholders + envSnapshot(workDir)
  - 输出 binding: { NAME → 具象值 }（补全所有 required）
  - 留 1KB「装配理由」给 metadata.provenance.bindingRationale

机械步骤:
  - 深拷贝 def.body / def.interface
  - 替换所有 ${{ NAME }} → binding[NAME]
  - 校验：不得残留 ${{ ... }}
  - 生成 LocalNode {
      id: "imported/<def.id>@<def.version>"
      origin: "imported"
      sourceDef: "<def.id>@<def.version>"
      workDir, createdAt, updatedAt = now
    }
  - 写 .brain/local_nodes/imported/<...>.json
  - drive9 catalog: importCount += 1, lastImportedAt = now

binding 失败时:
  - skip 该 def（search_and_instance.failed[] 记录）
  - drive9 catalog: assembleFailCount += 1
```

---

## 7. NodeDef 治理：防爆炸

### 7.1 dedupe（写入前）

```text
on_export(localNode):
  dedupeKey = sha256(canonicalize(body) + canonicalize(interface))
  match = catalog.findByDedupeKey(dedupeKey)
  if match:
    if same content → 仅 bump citeCount，不新建 version
    if minor diff → 升 version；旧 version 仍 active，eviction 后台决策
  else:
    create new NodeDef
```

### 7.2 quota（每 agent）

| 配置 | 默认 | 来源 |
|------|------|------|
| `NODE_DEF_MAX_PER_AGENT` | 200 | env / agent.json |
| `NODE_DEF_EVICTION_HEADROOM` | 20%（即 evict 到 0.8 × max） | 同上 |

到达 quota 时不阻塞 export；export 后排 eviction sweep。

### 7.3 cold tombstone（外脑 sweep）

模块：`nodeDefEviction`（外脑，与 `kpiCompletionJudge` / `staleBurstReaper` 同心跳级别）。

```text
score(def) =
    + w_import * importCount
    + w_cite   * citeCount
    - w_age    * ageDays
    - w_fail   * assembleFailCount

候选 tombstone:
  importCount == 0 && ageDays > 30
  OR
  count(active) > max && score 排末 K（直到回到 max - headroom）

操作:
  status: active → tombstone
  move defs/<id>@<v>.json → archive/
  index.json 更新
  保留 id 记录（防止重复创建同名垃圾）
```

P1 仅启 dedupe + quota，eviction 走「冷 30 天」单条规则；P2 加分数函数与外脑 sweep。

> **实现状态（P2 ✅）**：`outer/node-def-eviction.ts` 导出纯函数 `scoreEntry(entry, now, weights)`
> 与 `runNodeDefEviction(store, opts)`。先做 cold sweep（`importCount==0 && ageDays>coldDays`），
> 再做 quota sweep（`active>maxActive` 时按 score 升序 tombstone 至 `floor(max*(1-headroom))`）。
> 默认权重 `{import:5, cite:2, age:0.1, fail:3}`，`maxActive=200 / headroomRatio=0.2 / coldDays=30`。
> 注入 `NodeDefDrive9Store`，由外脑心跳周期调用。测试见 `node-def-eviction.test.ts`。

---

## 8. 预置节点 seeding

```text
worker 启动:
  presetSeeder(workDir):
    if .brain/local_nodes/preset 不存在:
      copy <innerWorker pkg>/preset/*.json → .brain/local_nodes/preset/
      LocalNode.origin = "preset"

P0 preset 列表:
  preset/base.json
  （preset/node_creator 已移除 — 节点提升走 Designer promote_local_node，见 DYFLOW-INNER-EXECUTOR.md §7/§9b）

P2 preset:
  preset/extract_facts（环境事实提取）✅
```

> **实现状态**：preset 节点以 TS 常量存于 `inner-brain/preset-nodes.ts`（`PRESET_BASE` /
> `PRESET_EXTRACT_FACTS`），`presetSeeder` 启动时幂等写入
> `.brain/local_nodes/preset/`。`preset/extract_facts` 是 baseNode（`tools:
> ['record_fact','read_file','search_files','shell_exec']`），把稳定环境事实写入
> `memory.facts`。`record_fact` / `record_constraint` 由 runner 在派发 baseNode 时
> 经 `inner-brain/memory-tools.ts` 注入（合并进 allowlist 过滤前的工具集），故任意
> baseNode 都可固化事实/约束。测试见 `extract-facts.test.ts`。

**preset 不 export**；版本随 worker 包升级，不参与 dedupe。

---

## 9. ADL 组件（与 inner-worker.dsl / agent-server.dsl 同步）

| 模块 ID | 路径 | 所在容器 | P 阶段 |
|---------|------|---------|--------|
| **localNodeStore** | `openkuroneko/inner-brain/local-node-store.ts` | innerWorker | **P0** |
| **memoryStore** | `openkuroneko/inner-brain/memory-store.ts` | innerWorker | **P0** |
| **nodeAbstractor** | `openkuroneko/inner-brain/node-abstractor.ts` | innerWorker | **P1** |
| **nodeAssembler** | `openkuroneko/inner-brain/node-assembler.ts` | innerWorker | **P1** |
| **nodeDefDrive9Store** | `drive9/node-def-drive9-store.ts` | agentServer（库，inner 注入） | **P1** |
| **nodeDefEviction** | `outer/node-def-eviction.ts` | agentServer（外脑 sweep） | **P2** |
| **presetSeeder** | `openkuroneko/inner-brain/preset-seeder.ts` | innerWorker | **P0** |

---

## 10. 测试计划（COMPONENT-TEST-MAP）

| 模块 | 单元测 | 模块测 | Prompt 测 |
|------|--------|--------|-----------|
| localNodeStore | ⏳ schema / index 一致性 | ⏳ commit + read + remove | — |
| memoryStore | ⏳ key 命名 / json patch | ⏳ last_failure 写读 | — |
| nodeAbstractor | ⏳ 校验：sanitized 无残留 | ⏳ FakeLLM → Def | ⏳ 真实 LLM placeholder 推断 |
| nodeAssembler | ⏳ 替换不残留 ${{}} | ⏳ Def + binding → LocalNode | ⏳ 真实 LLM binding |
| nodeDefDrive9Store | ⏳ index 维护 | ⏳ put/get/list/tombstone | — |
| nodeDefEviction | ⏳ score 函数 | ⏳ quota + cold | — |
| presetSeeder | — | ⏳ 首次 spawn 注入 + 已存在跳过 | — |
| **Designer 工具 search_and_instance** | ⏳ 装配失败包容 | ⏳ 多 def → 部分成功 | — |

---

## 11. 与 Memory Storage Boundary 的关系

drive9 `/nodes/shared/` 在 [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) 已新增一行：

| 层 | 技术 | 路径 / API | 谁写 | 谁读 |
|----|------|------------|------|------|
| **节点 drive9** | HTTPS | `/nodes/shared/` | 内脑 nodeAbstractor（Creator commit auto）+ 外脑 nodeDefEviction（tombstone） | Designer tool `search_and_instance`（→ Assembler） |

**禁止**：

- baseNode / Designer prompt 直读 NodeDef 正文（应只通过 Assembler 装配后再 ref LocalNode）
- 任何模块绕过 `nodeDefDrive9Store` 直访 drive9 `/nodes/shared/`

---

## 12. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-25 | §4：`search` **禁止** grep 空时回退全量 active；默认 topK **5**。理由：kuroneko ib-ms07nqqi-d102 DESIGN 灌入无关 weibo/repair NodeDef |
| 2026-06-08 | 节点绑定技能：Attributor record_skill、Runner 执行前加载、promote/Assembler 携带；见 [`INNER-NODE-SKILLS.md`](./INNER-NODE-SKILLS.md) |
| 2026-06-02 | 初版：LocalNode/NodeInst/NodeDef 三概念；Abstractor LLM placeholder + auto-export；Assembler LLM binding；search_and_instance 批量装配；dedupe + quota + cold tombstone；preset seeding |
