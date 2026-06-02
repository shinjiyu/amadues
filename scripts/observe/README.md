# Agent Run 观测（数据分析）

分析**已跑完**的 agent `DATA_ROOT`，不启动测试。结果默认落在**仓库外**，切 branch 不丢。

## 落盘位置

| 优先级 | 路径 |
|--------|------|
| 1 | 环境变量 `KURONEKO_OBSERVATIONS_DIR` |
| 2 | `<kuroneko 仓库>/../kuroneko-observations/` |

Windows 示例：`D:\kuroneko-observations\`

## analyze-run

```bash
node scripts/observe/analyze-run.mjs \
  --data-root packages/server/data-yuanbao \
  --from 2026-05-31T19:00:00.000Z \
  --to 2026-06-01T17:00:00.000Z \
  --kind pokemon \
  --label baseline-v0
```

输出：

```text
kuroneko-observations/runs/pokemon/<run-id>/
  run-meta.json
  RunReport.json
  RUN-SUMMARY.md
```

不写 `--from` / `--to` 时：usage 全量 + registry 中**全部** burst（适合事后整包分析）。

## compare-runs

```bash
node scripts/observe/compare-runs.mjs \
  --baseline D:/kuroneko-observations/runs/pokemon/<baseline-id> \
  --candidate D:/kuroneko-observations/runs/pokemon/<candidate-id>
```

输出：`kuroneko-observations/comparisons/compare-.../DELTA.md`

## 指标

见 [`doc/structurizr/TASK-RUN-OBSERVABILITY.md`](../../doc/structurizr/TASK-RUN-OBSERVABILITY.md) §4。
