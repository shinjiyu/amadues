# 测试报告 / Test reports

| 文件 | 说明 |
|------|------|
| [`test-report-latest.md`](./test-report-latest.md) | 最近一次全量 vitest 汇总的 **Markdown 快照**（由脚本写入，非实时） |

## 生成 / Generate

```bash
# 先在各 workspace 跑测并产出 .tool-outputs/test-report-YYYYMMDD/*.json
node scripts/generate-test-report.mjs .tool-outputs/test-report-YYYYMMDD
```

输出：

- `doc/reports/test-report-latest.md`（本目录）
- `.tool-outputs/test-report-YYYYMMDD/REPORT.md`（同内容副本）

> **注意**：快照中的失败项可能已在后续 commit 修复；以本地重跑 `npm test` / `npm run test:prompt -w @utlra/server` 为准。
