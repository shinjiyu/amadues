# 内脑文件访问策略（read_file / 大文件）

> **English:** Agents should not dump whole large files into LLM context. Prefer **search → paginated read → shell slice**; catalog/summary at spawn boundaries.

与 [`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md)（spawn 只传名字+摘要）互补。

---

## 1. 问题

| 现象 | 后果 |
|------|------|
| `read_file` 一次读全文件 | 600KB 小说 → 上下文爆炸 / 截断丢信息 |
| 无分页参数 | LLM 无法「只看第 3 章」 |
| 与 inbox 目录重复 | spawn 已给摘要，EXECUTE 又整文件 read |

**现状（代码）**：`read-file-lines.ts` 共享分页；`read-file.ts` / `read_peer_file` 支持 `offset_line` / `limit_lines`。

---

## 2. 业界常见做法

| 方案 | 代表 | 做法 |
|------|------|------|
| **分页读** | Cursor `Read`、Claude Code `Read(offset, limit)` | 默认 cap（如 250 行）；返回 `lines M–N of total`；超大文件强制分页 |
| **先搜后读** | Devin、SWE-agent | `grep`/`search` 定位行号 → 只读命中附近窗口 |
| **元数据工具** | OpenHands `str_replace_editor` view | `view path` 带 line range；或单独 `file_size` / `list_dir` |
| **Shell 切片** | 多数 coding agent | `head -n 200`、`sed -n '100,200p'`、`wc -l` 经 `shell_exec` |
| **不读全文** | RAG / repo-index | 索引摘要进 context；全文只在检索命中时局部读 |
| **硬上限 + 截断提示** | 部分 API agent | 超 N KB 返回前 N 字符 + `[truncated, use offset]` |

共同原则：**默认小窗口、显式扩大、工具输出带行号/范围元数据**。

---

## 3. 本仓库目标模式（✅ P1）

### 3.1 工具分层

```text
发现：.inbox/README.md | list_peer_files | search_files / search_peer_files
定位：search_* 返回 path:line
读取：read_file(path, offset_line?, limit_lines?)  ← 默认 limit=200
大文件：read_peer_file 同参数；或 shell_exec head/tail
```

### 3.2 read_file 契约（已实现）

| 参数 | 默认 | 说明 |
|------|------|------|
| `path` | 必填 | workDir 相对路径 |
| `offset_line` | 1 | 1-based 起始行 |
| `limit_lines` | 200 | 最大行数；上限 500 |

**输出格式**（对齐 Cursor 可读性）：

```text
[lines 1-200 of 8421 total, 557273 bytes]
001| # 第一章
002| ...
...
(truncated: call read_file with offset_line=201)
```

| 规则 | 行为 |
|------|------|
| **R1** | 文件 > `UTLRA_READ_FILE_WHOLE_MAX_BYTES`（默认 64KiB）且未传 limit → 强制分页模式 |
| **R2** | 二进制 / 非 UTF-8 → 拒绝，提示 `shell_exec` 或只读 bytes 统计 |
| **R3** | `read_peer_file` 共享同一分页实现 |
| **R4** | executor prompt：大产物先 `.inbox` 目录 → `search_*` → 分页 `read_*` |

### 3.3 与 inbox 分工

| 阶段 | 传什么 |
|------|--------|
| spawn | 名字 + ~280 字摘要（`.inbox/catalog.json`） |
| EXECUTE | 按需分页读正文，不默认整文件 |

---

## 4. ADL 组件

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| `innerFileTools` | `read-file-lines.ts` + `read-file.ts` + `peer-file-tools.ts` | 分页读 ✅ |
| `fileSearch` | `file-search.ts` | search 先定位 |
| `workspaceInbox` | `workspace-inbox.ts` | spawn 摘要目录 |

---

## 5. 测试

| 类型 | 文件 |
|------|------|
| 单测 | ✅ `read-file-lines.test.ts`（分页、截断提示、二进制拒绝） |
| 组件 | ⏳ 大文件 novel 场景：search → offset read |

---

## 6. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-01 | 初版：业界模式 + read_file 分页 ADL（未实现） |
| 2026-06-02 | P1：`read-file-lines.ts` + `read_peer_file` 同参 |
