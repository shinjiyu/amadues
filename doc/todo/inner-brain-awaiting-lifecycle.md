# 内脑 AWAITING 生命周期（实现待办）

> **English:** Design in [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](../structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md). P0 landed 2026-05-28.

**状态**：P0 **已实现**（2026-05-28）· P1+ 待做

## P0

- [x] `registry-lifecycle-reconcile.ts` — `is_post_complete` / 无 async 等待 → registry `DONE`
- [x] `index.ts` 启动：`registryLifecycleReconcile()` 在 `changeWatcher.start()` 之前 + bootstrap 回调
- [x] `changeWatcher.start()` — `bootstrap()`：reconcile + 全表 timer 补单
- [x] `awaiting-inbound-resolver.ts` — 人 IM → 同 `originThread` 的 `ask_user` resolve
- [x] `outer-brain.ts` — Facade 挂载 resolver（meta 之后、知识检索之前）
- [x] 单测：`registry-lifecycle-reconcile.test.ts`、`awaiting-inbound-resolver.test.ts`、`change-watcher.bootstrap.test.ts`（23 项通过）

## P1+

- [x] 多 AWAITING 同 thread：正文带 `instance_id` 消歧（MVP 已在 resolver 实现）
- [ ] 周期 reconcile（可选 60s）+ 指标
- [ ] 组件测：`registryLifecycleReconcile.component.integration.test.ts`、`awaitingInboundResolver.component.integration.test.ts`

## 杂项

- [ ] `npm run structurizr:check` 中 `structurizr:deps` 在默认堆下 OOM；可单独 `validate.bat` 或加大 `NODE_OPTIONS`

## 参考

- ADL：`doc/structurizr/components/agent-server.dsl`、`workspace.dsl` 视图 07/08
- 宪法：`doc/agent-data-state-machine.md` §6.2
- 现有：`brain-async-snapshot.ts`、`change-watcher.ts`、`inner-brain-startup-resume.ts`
