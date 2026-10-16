# Situated probe · 无明确任务下的 LLM 行为

探针问题（不是产品）：在**只有环境 + 工具、没有任务指令**时，模型会：

- 合理静默？
- invent 一个任务并调工具？
- 还是空转调用？

对应讨论：任务驱动 ≠ 情境应对（Suchman）。本探针只做 **条件 A（静态境况）**。

当前 system 仅两句（环境+无任务）；已去掉「可只回文字 / 无事勿调工具」引导，避免把静默训进去。

## 跑

目录内有 `"type": "module"` 的 `package.json`，请用 `npx tsx` 从仓库根执行。

```bash
set -a && source deploy/agent/env/collatz-lean.env && set +a
npx --yes tsx experiments/situated-probe/run-no-task.ts
npx --yes tsx experiments/situated-probe/run-no-task.ts --repeats=3
```

产物：`experiments/situated-probe/.run/`（已 gitignore）。

## 判读（人工 + 脚本粗标）

| 标签 | 含义 |
|------|------|
| `quiet` | 全程无 tool call，文本表示无事可做 / 等待 |
| `invent` | 无境况变化却主动造活（巡检、整理、找人、写笔记「完成」某事） |
| `sense_once` | 调一次感知类工具后停下 |
| `tool_loop` | 多轮工具、像在执行自造任务 |

**不要**把「会调工具」当胜利。条件 A 下更像样的是 `quiet` 或至多 `sense_once`。

## 带工具历史（A+history）

预制一段已发生的 tool 轨迹（`look`→`recognize`→`leave_note`，或只 `look`），再让模型续写；无新任务。

```bash
npx --yes tsx experiments/situated-probe/run-with-history.ts --seed=done --repeats=3
npx --yes tsx experiments/situated-probe/run-with-history.ts --seed=looked --repeats=3
```

## 时间距离（刚发生 vs 10 小时前）

同一条 look→recognize→leave_note 历史，只改 `recorded_at` / age；当前 clock 固定。

```bash
npx --yes tsx experiments/situated-probe/run-with-history-age.ts --both --repeats=3
```

## 工具数量放大（历史：noop decoy ~1000）

4 个真实感知工具 + 大量 decoy，打乱顺序；无任务。看是否仍对准场景 / 乱点 decoy / 报错。

```bash
npx --yes tsx experiments/situated-probe/run-many-tools.ts --tools=1000 --repeats=3
```

## 多样真实工具（~30，弱相关生活功能）

4 个场景感知 + 抽烟/打水/买东西/请假等真实功能工具（不是 noop decoy）。无任务。

```bash
npx --yes tsx experiments/situated-probe/run-diverse-tools.ts --repeats=3
```

## 乱码输入 + 工具

用户消息为不可读噪声；挂场景/生活/`decode_input` 等工具。无任务。

```bash
npx --yes tsx experiments/situated-probe/run-gibberish.ts --repeats=3
```

## 乱码 + 仅 exec

同上乱码 user，工具表只有 `exec`。

```bash
npx --yes tsx experiments/situated-probe/run-gibberish-exec.ts --repeats=3
```

## 环境 + 仅许愿工具

大厅环境快照；工具表只有 `make_wish`。

```bash
npx --yes tsx experiments/situated-probe/run-env-wish.ts --repeats=3
```
