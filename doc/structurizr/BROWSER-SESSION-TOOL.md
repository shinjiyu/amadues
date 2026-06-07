# 内脑浏览器会话工具（`browser_*`）

> **English:** Stateful Playwright sessions inside the agent server — incremental UI automation without monolithic `write_file` + `shell_exec` scripts. Snapshots/screenshots spill to workspace; tool output stays short.

与 [`INNER-VISION-TOOL.md`](./INNER-VISION-TOOL.md)（截图识图）、[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §6.5（上下文治理）互补。

---

## 1. 动机（bot2 ch4 教训）

| 现象 | 根因 |
|------|------|
| 每次 `shell_exec` 从 `/main/writer/` 重来 | 脚本 `launch` → `close`，无 session |
| 弹窗状态下一轮丢失 | 进程结束浏览器死 |
| `pub_ch4_v2.py` 连环新文件 | 无增量把手；`write_file` 整脚本路径 |

**原则**：浏览器操作走 **`browser_open` → `browser_act` × N → `browser_close`**；章节/JSON 仍用 `write_file`。

---

## 2. 工具契约（P0）

### 2.1 `browser_open`

| 参数 | 说明 |
|------|------|
| `label` | 可选人类标签（审计） |
| `headless` | 默认 `true`（`INNER_BROWSER_HEADLESS=0` 可改默认 headed） |
| `viewport_width` / `viewport_height` | 默认 1280×900 |
| `cookies_file` | workDir 内 JSON（含 `cookie` 字符串或 Playwright cookies 数组） |
| `storage_state` | workDir 内 Playwright `storageState` JSON 路径 |
| `user_agent` | 可选 |

**Out**：`session_id`（`br-xxxxxxxx`）、`hint`（后续 `browser_act` 必带 `session_id`）

### 2.2 `browser_act`

| 参数 | 说明 |
|------|------|
| `session_id` | 必填 |
| `action` | 见下表 |

| action | 额外参数 | 行为 |
|--------|----------|------|
| `goto` | `url`, `timeout_ms?` | 导航 |
| `click` | `selector?` 或 `text?` | 点击（二选一） |
| `fill` | `selector`, `value` | `locator.fill` |
| `type` | `selector`, `text`, `delay_ms?` | `locator.pressSequentially` |
| `press` | `key` | `page.keyboard.press` |
| `wait` | `ms?` 或 `selector?` + `state?` | 等待 |
| `screenshot` | `path` | 落盘 PNG（workDir 相对路径） |
| `snapshot` | `path?` | Playwright `ariaSnapshot` 文本；`path` 给定则全文落盘 |
| `evaluate` | `expression` | `page.evaluate`（单行/短表达式） |
| `state` | — | 返回 `url` + `title` + 一行摘要 |

**Out**（JSON 字符串）：`ok`, `url`, `title`, `summary?`, `screenshot?`, `snapshot_path?`

### 2.3 `browser_close`

| 参数 | 说明 |
|------|------|
| `session_id` | 关闭单个；省略且 `all=true` 时关闭本 workDir 全部 |

### 2.4 `browser_list`

列出本 workDir 活跃 `session_id` + `label` + `url`。

### 2.5 `browser_run_steps`（P1 · 脚本化）

**一次 tool 调用**在已有 `session_id` 上顺序执行多步 `browser_act` 语义；浏览器保持增量，不额外消耗 ReAct 轮次。

| 参数 | 说明 |
|------|------|
| `session_id` | 必填 |
| `steps` | 内联 JSON：步骤数组或 `{ steps: [...] }` |
| `playbook` | workDir 内 `.json` 路径（与 `steps` 二选一） |
| `from_step` | 从第几步续跑（0-based）；失败后可从 `failed_step` 重试 |
| `stop_on_error` | 默认 `true` |

**Playbook 文件示例**（`workspace/publish_ch4.playbook.json`）：

```json
{
  "label": "fanqie-publish-ch4",
  "stop_on_error": true,
  "steps": [
    { "action": "goto", "url": "https://fanqienovel.com/main/writer/..." },
    { "action": "fill", "selector": "#title", "value": "第4章" },
    { "action": "click", "text": "下一步" },
    { "action": "screenshot", "path": "workspace/ch4_step.png" },
    { "action": "click", "text": "提交" }
  ]
}
```

**Out**：`{ ok, completed, total, from_step, results[{step,action,ok,error?}], failed_step?, url?, title? }`

| 模式 | 何时用 |
|------|--------|
| `browser_act` × N | 探索、DOM 不确定、需 vision 介入 |
| `browser_run_steps` | 路径已固化；`record_fact` 记 playbook 路径后复用 |

实现：`browser/browser-playbook.ts` · 上限 50 步/次。

---

## 3. 生命周期

```text
browserSessionRegistry（进程内单例）
  Map<sessionId, { browser, context, page, workDir, nodeInstId, … }>

browser_open     → register
browser_act        → touch session（校验 workDir 一致）
runBaseNode 结束 → closeSessionsForNode(nodeInstId)   # 成功/失败/cap/fail_fast 均执行
browser_close    → 显式释放
```

| env | 默认 | 说明 |
|-----|------|------|
| `INNER_BROWSER_MAX_PER_WORKDIR` | 3 | 超限拒绝 `browser_open` |
| `INNER_BROWSER_HEADLESS` | 1 | 默认 headless |
| `INNER_BROWSER_ACTION_TIMEOUT_MS` | 15000 | act 默认超时 |

---

## 4. 与 Playwright MCP / CLI 的关系

| 能力 | Playwright MCP | 本设计 |
|------|----------------|--------|
| 增量 session | server 单例 | `session_id` + registry |
| 元素定位 | a11y `ref=e5` | P0：`selector` / `text`；snapshot 为 role+name 树 |
| Token | 大树 inline | snapshot/screenshot **落盘**，tool 返回路径+摘要 |
| DyFlow 清理 | 弱 | **node 结束强制 close** |

---

## 5. ADL 组件

| 模块 ID | 路径 |
|---------|------|
| `browserSessionRegistry` | `browser/session-registry.ts` |
| `browserSessionScope` | `browser/session-scope.ts` |
| `browserPageSummary` | `browser/page-summary.ts` |
| `browserTools` | `tools/definitions/browser-tools.ts` |

注册：`pi-mono/run-tick.ts` executor 工具集。

---

## 6. Prompt 契约（preset/base）

- **UI 自动化**：`browser_open` → 多步 `browser_act` → `browser_close`；**不要** `write_file` 写 Playwright 脚本再 `shell_exec`。
- 截图后用 `describe_image`；勿 `read_file` 二进制 PNG。
- 稳定选择器/步骤用 `record_fact`；跨节点可 `storage_state` 落盘（P1 checkpoint）。

---

## 7. 测试

| 类型 | 文件 |
|------|------|
| 单测 | `session-registry.test.ts`、`browser-tools.test.ts`（`file://` fixture HTML） |

---

## 8. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-07 | P0：`browser_open` / `browser_act` / `browser_close` / `browser_list` + node 清理 |
| 2026-06-07 | P1：`browser_run_steps`（内联 steps + playbook 文件 + `from_step` 续跑） |
