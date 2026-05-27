# 内脑 AWAITING 生命周期（实现待办）

> **English:** Design is done in [`doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md`](../structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md). Code not started (user deferred 2026-05-27).

**状态**：**待实现**

## P0

- [ ] `registry-lifecycle-reconcile.ts` — `is_post_complete` / 无 async 等待 → registry `DONE`
- [ ] `index.ts` 启动：`registryLifecycleReconcile()` 在 `changeWatcher.start()` 之前
- [ ] `changeWatcher.start()` — `bootstrap()`：reconcile + 全表 timer 补单
- [ ] `awaiting-inbound-resolver.ts` — 人 IM → 同 `originThread` 的 `ask_user` resolve
- [ ] `outer-brain.ts` — Facade 挂载 resolver（policy 之后、conversationLoop 之前）

## P1+

- [ ] 多 AWAITING 同 thread：正文带 `instance_id` 消歧
- [ ] 周期 reconcile（可选 60s）+ 指标
- [x] 测试用例（TDD，实现前）：`registry-lifecycle-reconcile.test.ts`、`awaiting-inbound-resolver.test.ts`、`change-watcher.bootstrap.test.ts`
- [ ] 实现通过上述单测 + 组件测

## 杂项

- [ ] `npm run structurizr:check` 中 `structurizr:deps` 在默认堆下 OOM；可单独 `validate.bat` 或加大 `NODE_OPTIONS`

## 参考

- ADL：`doc/structurizr/components/agent-server.dsl`、`workspace.dsl` 视图 07/08
- 宪法：`doc/agent-data-state-machine.md` §6.2
- 现有：`brain-async-snapshot.ts`、`change-watcher.ts`、`inner-brain-startup-resume.ts`
