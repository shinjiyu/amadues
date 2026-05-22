# Kuroneko 全量测试报告

| 字段 | 值 |
|------|-----|
| 生成时间 | 2026-05-21T11:39:26.155Z |
| 总体结论 | **未通过** |
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

## 失败用例明细

### @utlra/chat-server — `e2e.test.ts`

- **用例**: §9.6 WebChatChannel 适配器：agent 收到 human 消息并能回复（与 Discord 模式等价）
- **信息**: `Error: onAgentMessage timeout
    at Timeout._onTimeout (D:\kuroneko\apps\chat-server\src\e2e.test.ts:359:43)
    at listOnTimeout (node:internal/timers:588:17)
    at processTimers (node:internal/timers:523:7)`

### @utlra/server · prompt (真实 LLM) — `attributor.prompt.test.ts`

- **用例**: 执行成功、无错误 → 可解析 CONTROL（主路径）
- **信息**: `Error: Test timed out in 90000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
    at Timeout.<anonymous> (file:///D:/kuroneko/node_modules/@vitest/runner/dist/index.js:44:18)
    at listOnTimeout (node:internal/timers:588:17)`

### @utlra/server · prompt (真实 LLM) — `decomposer.prompt.test.ts`

- **用例**: 初次规划 → 合格 milestones + 契约行（主路径）
- **信息**: `Error: Test timed out in 120000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
    at Timeout.<anonymous> (file:///D:/kuroneko/node_modules/@vitest/runner/dist/index.js:44:18)
    at listOnTimeout (node:internal/timers:588:17)`

### @utlra/server · prompt (真实 LLM) — `reflexion.prompt.test.ts`

- **用例**: BLOCK 退出 → verdict 字段可解析（主路径）
- **信息**: `Error: Test timed out in 90000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
    at Timeout.<anonymous> (file:///D:/kuroneko/node_modules/@vitest/runner/dist/index.js:44:18)
    at listOnTimeout (node:internal/timers:588:17)`

## 复现命令

```bash
# Monorepo 轻量（不含 server 集成 / prompt）
npm test

# Server 全量三联
npm run test -w @utlra/server

# 可选 live 子进程
# Windows PowerShell:
$env:UTLRA_TEST_SPAWN_INNER = "1"
npm run test:integration -w @utlra/server

npm run structurizr:check
```
