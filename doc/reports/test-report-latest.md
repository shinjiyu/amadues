# Kuroneko 全量测试报告 / Full test report

> **快照说明 / Snapshot note**（2026-05-21 生成）：下列 4 项失败已在后续修复（`peerAgentUserIds`、`LLM_STREAM_IDLE_MS` 解析等）。重跑全量测试后请执行 `node scripts/generate-test-report.mjs …` 更新本文件。  
> The failures listed below were fixed in later commits; regenerate this file after a fresh test run.

| 字段 | 值 |
|------|-----|
| 生成时间 | 2026-05-21T11:39:26.155Z |
| 总体结论 | **未通过**（历史快照） |
| 用例合计 | 394 passed · 4 failed · 1 skipped |
| 原始产物 | [`.tool-outputs/test-report-20260519/`](../../.tool-outputs/test-report-20260519/) |

## 分套件汇总

| 套件 | 结果 | 通过 | 失败 | 跳过 | 备注 |
|------|------|------|------|------|------|
| @utlra/chat-ir | ✅ | 24 | 0 | 0 |  |
| @utlra/webchat-protocol | ✅ | 7 | 0 | 0 |  |
| @utlra/webchat-bridge | ✅ | 7 | 0 | 0 |  |
| @utlra/chat-server | ❌ | 10 | 1 | 0 |  |
| @utlra/server · unit | ✅ | 268 | 0 | 0 |  |
| @utlra/server · integration | ✅ | 70 | 0 | 1 | 含 1 项 live spawn（默认 skip） |
| @utlra/server · prompt (真实 LLM) | ❌ | 8 | 3 | 0 | 真实 LLM；超时视为失败 |
| structurizr:check | ✅ | — | — | — | ADL validate + deps |

## 失败用例明细（历史）

### @utlra/chat-server — `e2e.test.ts`

- **用例**: §9.6 WebChatChannel 适配器：agent 收到 human 消息并能回复（与 Discord 模式等价）
- **信息**: `Error: onAgentMessage timeout`

### @utlra/server · prompt (真实 LLM)

- attributor / decomposer / reflexion 主路径 — Test timed out（后确认为 `parseInt('90_000')` → 90ms 流式 idle）

## 复现命令

```bash
npm test
npm run test -w @utlra/server
npm run test:prompt -w @utlra/server
npm run structurizr:check
```
