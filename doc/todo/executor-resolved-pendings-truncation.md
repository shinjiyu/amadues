# TODO：内脑 Executor 注入 resolved pending 时 600 字截断

> **Status:** 已实现 · **Recorded:** 2026-05-27 · **Landed:** 2026-05-28  
> **English:** `ask_user` / IM answers land in `pendings.json` intact, but `runExecutor` previews `result` with `JSON.stringify(...).slice(0, 600)`, breaking cookies and other large payloads.

**状态**：**已实现**（2026-05-28）

## 实施清单

- [x] `executor.ts`：`formatResolvedPendingResultForPrompt` — spill 到 `.brain/inbound/pending-results/`
- [x] resolved 段操作指引（步骤 5：大 result → `read_file`）
- [x] 回归：`executor-resolved-pendings.test.ts`

关联：[`cross-agent-research-and-keychain.md`](./cross-agent-research-and-keychain.md)（钥匙串 + bind 为长期方案）· [`executor.ts`](../../packages/server/src/openkuroneko/controller/executor.ts) · [`controller.ts`](../../packages/server/src/openkuroneko/controller/controller.ts)

---

## 现象

内脑在 AWAITING 收到人类回复（如整段 Cookie、`ask_user` 答案）后进入下一轮 EXECUTE，Executor 的 user prompt 里「等待已 resolved 的事件」段中 **`result` 被截断**，内脑 LLM 用残缺内容执行 `curl` / 脚本，并可能误判为「Cookie 被截断」再次 `ask_user`。

典型实例：**Gin** `ib-mpo4o2nx-a598`（微博 Cookie / SUB）。

---

## 根因（已核对）

| 环节 | 是否截断 | 说明 |
|------|----------|------|
| 外脑 `send_directive` / `directives.jsonl` | ❌ 否 | 完整 Cookie 曾出现在 directive |
| `pendings.json`（`pend-mpo4pfk5-9ee9be` 等） | ❌ 否 | `result` 磁盘上完整 |
| **Executor `resolvedSection`** | ✅ **是** | `JSON.stringify(r.result).slice(0, 600)` |
| 内脑工具 `read_file` 读 directive | 视路径而定 | 若 LLM 不读文件、只信 prompt 里的 `result`，仍会失败 |

**结论**：不是 IM 通道或外脑 directive 的主因，而是 **内脑把 resolved pending 注入 LLM 时做了硬编码 600 字符预览**。

代码位置：

```237:237:packages/server/src/openkuroneko/controller/executor.ts
          const resPreview = JSON.stringify(r.result ?? null).slice(0, 600);
```

数据流：

```text
controller.listUnconsumedResolvedPendings()
  → resolvedForLLM[]（完整 p.result）
  → runExecutor({ resolvedPendings })
  → resolvedSection 内 resPreview 仅 600 字 → 内脑 LLM
```

---

## 与「外脑 600」区分

| 位置 | 常量/行为 | 用途 |
|------|-----------|------|
| `executor.ts` resolved pending | **600** | ⚠️ 本 TODO |
| `outer/knowledge-retrieval.ts` | `MAX_CHARS_PER_ITEM = 600` | 外脑检索注入，**另一路径** |
| `executor.ts` tool output | `TOOL_OUTPUT_INLINE_MAX = 3000` | 工具输出落盘 `.tool-outputs/`，**已有 spill 模式** |

修复 resolved pending 时，**复用 tool output 的 spill 思路**，不必与 knowledge-retrieval 混为一次改动。

---

## 目标

1. **完整 payload** 对内脑可用：凭证、长 JSON、多行 Cookie 不因 600 字丢失。
2. **Prompt 仍可控**：超长内容不进 inline，改为 **文件引用 + 短摘要**（与 `compressToolOutput` 一致）。
3. **日志安全**：凭证类 spill 文件路径可打日志；**value 不打全文**（长度 + slot/key 即可）。
4. **可验收**：同场景下内脑 `curl` 使用完整 SUB，不再出现「假截断」式 `ask_user`。

---

## 建议方案（P0）

### A. Spill 到 workDir（推荐，与现有模式一致）

在 `runExecutor` 构建 `resolvedSection` 时：

```text
若 JSON.stringify(result).length > THRESHOLD（建议 2000 或与 TOOL_OUTPUT_INLINE_MAX 对齐）:
  写入 workDir/.brain/inbound/pending-results/{pendingId}.json
  prompt 内:
    result: [已写入文件，共 N 字符] path=.brain/inbound/pending-results/{id}.json
    preview: <头 500 + 尾 200 可选>
否则:
  内联完整 result（小对象不截断）
```

内脑已有 `read_file`；prompt 明确要求：**大 result 必须先 read_file 再执行**。

### B. 结构化 result（P1，与钥匙串配合）

外脑 / resolver 在 resolve `ask_user` 时，若识别为凭证：

```json
{ "kind": "credential_ref", "slot": "weibo", "path": ".brain/secrets/weibo.json", "byteLength": 4123 }
```

Executor 只注入 ref，不 stringify 原文（见钥匙串 todo）。

### C. 禁止单独保留 600（反模式）

不要「把 600 改成 4000」了事——仍会爆 prompt，且与 tool output 策略不一致。

---

- [ ] `executor.ts`：去掉固定 `slice(0, 600)`；实现 spill + 摘要或阈值内联全文
- [ ] `executor.ts` / 文档：resolved 段增加一句操作指引（大 result → `read_file`）
- [ ] （可选）`controller.ts`：构建 `resolvedForLLM` 前对大 `result` 预 spill，避免重复序列化
- [ ] 回归：构造 >600 字 `ask_user` result 的 pending，断言 prompt 含路径且 `read_file` 可得全文
- [ ] 案例备注：Gin `ib-mpo4o2nx-a598` 写入 doc/reports 或测试 fixture 名（脱敏）

---

## 验收（已通过单测）

- [x] spill 文件全文 = 原始 JSON
- [x] >600 字 inline 不再硬截断（<3000 仍内联）
- [x] >3000 字 spill + read_file 路径

---

## 参考

- 注入逻辑：`packages/server/src/openkuroneko/controller/executor.ts`（`resolvedSection`）
- 来源：`packages/server/src/openkuroneko/controller/controller.ts`（`listUnconsumedResolvedPendings` → `resolvedForLLM`）
- 工具输出 spill：`compressToolOutput`（同文件 `TOOL_OUTPUT_INLINE_MAX`）
- 钥匙串长期方案：[`cross-agent-research-and-keychain.md`](./cross-agent-research-and-keychain.md) §K0
