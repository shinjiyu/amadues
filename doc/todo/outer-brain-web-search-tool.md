# TODO：外脑专用 Web Search 工具

> **Status:** 待实现 · **Recorded:** 2026-05-19  
> **English:** Outer brain needs its own web search tool — separate from inner-brain `web_search` / playwright burst tooling.

---

## 动机

外脑在 IM 对话、参与策略、任务编排时，常需要**轻量、即时**的网页检索（查事实、确认链接、扫一眼公开信息），不应为了搜一下网就 `set_goal` 启动整条内脑 burst。

当前 `web_search` 等能力主要挂在内脑 Executor / pi-mono 工具链上，外脑 `outerToolExecutor` **没有**对等的一等公民工具。

---

## 目标

1. 外脑 LLM 可通过 **`outerToolExecutor` 注册的工具** 直接发起 Web 搜索。
2. 与内脑 `web_search(engine: playwright|…)` **职责分离**：
   - **外脑**：快速检索、摘要、引用 URL（只读、低副作用）
   - **内脑**：需要浏览器自动化、登录态、多步交互时仍走 burst + playwright
3. 结果进外脑对话上下文，**默认不写 mem9 全文**（可选摘要由 LLM 决定是否 `write_memo` / Memory Block）。

---

## 非目标（初版）

- 不替代内脑 playwright 深度爬取
- 不与 Memory Block / keychain 耦合
- 不要求 Dashboard UI（可后续加）

---

## 待设计 / 实现

| 项 | 说明 |
|----|------|
| 工具名 | 待定，如 `outer_web_search` 或 `web_search`（外脑命名空间） |
| 引擎 | 复用现有 LLM/搜索 provider 配置，或独立 `OUTER_WEB_SEARCH_*` env |
| 输出 | 标题 + URL + 摘要片段；长度上限 + spill 策略对齐 outer 工具惯例 |
| 频控 | 可选：per-thread 冷却，避免外脑心跳/群聊刷搜索 |
| ADL | `doc/structurizr/` 补 outerToolExecutor → search provider 关系 |
| 测试 | `outerToolExecutor.component.integration.test.ts` + mock fetch |

---

## 验收

- [ ] 外脑 roundtrip / IM 触发后，LLM 可调用工具并完成一次搜索，结果出现在 `reply_to_user` 或后续轮上下文
- [ ] 内脑 burst 未启动时，外脑仍可独立搜索
- [ ] structurizr deps 规则：外脑搜索模块不 import 内脑 executor 工具注册表

---

## 修订

| 日期 | 说明 |
|------|------|
| 2026-05-19 | 用户 backlog：外脑需要专心用的 web search 工具 |
