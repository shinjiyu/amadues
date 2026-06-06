# 内脑识图工具（`describe_image`）

> **English:** Pi-mono ReAct stays text-only; raster images (screenshots, PNG deliverables) are understood via an explicit tool that calls the configured vision model and returns a text summary into the tool loop.

与 [`INNER-FILE-ACCESS.md`](./INNER-FILE-ACCESS.md)（`read_file` 拒绝二进制）、[`doc/inner-outer-protocol.md`](../inner-outer-protocol.md) §7.2（工具链读图）互补。

---

## 1. 问题

| 现象 | 后果 |
|------|------|
| Playwright / `shell_exec` 落盘 `.png` | `read_file` → `Binary or non-UTF-8` |
| Pi-mono adapter 仅 `textModel` | 即使用多模态 Key，ReAct 也看不到像素 |
| `UTLRA_GOAL_VISION_ENRICH` | 仅 spawn 前 goal 附图，不覆盖运行时截图 |

---

## 2. 方案

```text
shell_exec / web_search(playwright) / 产物截图
        → describe_image(path, prompt?)
        → loadInnerLlmEnvFromProcess().visionModel
        → 中文描述写入 tool output（纯文本，进 ReAct 历史）
```

| 原则 | 行为 |
|------|------|
| **显式调用** | LLM 决定何时识图，不自动把每张图塞进多模态消息 |
| **智谱优先** | 有 `ZHIPU_API_KEY` → **Vision MCP**（`@z_ai/mcp-server` `analyze_image`），与内脑文本 provider 无关 |
| **回退** | 无智谱 Key 时 → `runInnerLlmStep` 多模态（`LOCALMODULE_VISION_MODEL` / `KIMI_VISION_MODEL`） |
| **workDir 只读** | 经 `workdirGuard.isPathReadable`；与 `read_file` 同范围 |
| **输出文本** | 带 `[describe_image: <model>, <bytes>, <path>]` 头，便于日志与审计 |

---

## 3. 工具契约

| 参数 | 默认 | 说明 |
|------|------|------|
| `path` | 必填 | workDir 相对路径 |
| `prompt` | 见下 | 可选；针对图的提问（验证码、UI 状态、文字 OCR 等） |

默认 `prompt`（未传时）：

> 客观描述图中可见的关键内容（文字、布局、UI 状态、错误信息等）。2～6 句中文；勿编造图中没有的信息。

| 规则 | 行为 |
|------|------|
| **R1** | 扩展名 `.png` `.jpg` `.jpeg` `.webp` `.gif` |
| **R2** | 单文件 ≤ 6 MiB（与 goal-vision-enrich 一致） |
| **R3** | 无 `ZHIPU_API_KEY` 且多模态 env 不可用 → `ok:false` + 配置提示 |
| **R4** | vision API 失败 → `ok:false` + 上游错误摘要 |
| **R5** | baseNode preset：截图 / `read_file` 二进制失败后优先 `describe_image` |

---

## 4. ADL 组件

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| `describeImageTool` | `tools/definitions/describe-image.ts` | `describe_image` 工具 + `describeImageFile` 核心 |
| `innerLlmStep` | `llm/inner-llm-step.ts` | 有图时走 `visionModel` |
| `piMonoRunTick` | `pi-mono/run-tick.ts` | 注册于 executor 工具集 |

---

## 5. 环境变量（Bot2 推荐：文本 localmodule + 识图智谱 MCP）

```env
UTLRA_INNER_LLM_PROVIDER=localmodule
LOCALMODULE_API_KEY=...
LOCALMODULE_MODEL=GLM-5.1-FP8
# describe_image 专用（与文本 provider 解耦）：
ZHIPU_API_KEY=...
```

---

## 6. 测试

| 类型 | 文件 |
|------|------|
| 单测 | ✅ `describe-image.test.ts`（扩展名、大小、路径、mock vision） |

---

## 7. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-02 | 初版：`describe_image` + ADL |
| 2026-06-06 | 识图固定走智谱 Vision MCP（`zhipu-vision-mcp`）；LocalModule 仅作无 Key 回退 |
