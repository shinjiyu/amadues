# PSTune Loop — 宝可梦对战边打边调优

> **English:** Closed loop for Gen9 OU rated auto-battle: **live trace → replay export → offline injector → profile gate → hot reload**.  
> 与 [`TASK-RUN-OBSERVABILITY.md`](./TASK-RUN-OBSERVABILITY.md) `runKind=pokemon` 互补；元宝 workspace `task-ib-mpvf5dh8-6070` 为参考实现。

---

## 1. 原则

| 原则 | 说明 |
|------|------|
| **单源决策** | `shared_decision_engine.mjs` + `battle_engine.mjs`；调参走 `tuning_profiles/*.json` |
| **先回归再上线** | `regression_gate` 必须通过 `replay_injector` 固定集 |
| **Live 只产数据** | 实战写 `decision_trace.jsonl`；不直接改源码常量 |
| **可回滚** | `tuning_profiles/active.json` 指向当前 profile；失败保持旧版 |

---

## 2. 模块（6070 workspace）

| 模块 ID | 文件 | In → Out |
|---------|------|----------|
| **liveRunner** | `ou_auto_battle.mjs` | CLI → rated OU 对战 |
| **decisionBridge** | `strategy_bridge.mjs` | ranked actions → enhanced + intercept |
| **profileLoader** | `tuning/profile_loader.mjs` | profile JSON → runtime weights/constants |
| **traceLogger** | `ps_battle.mjs` | DecisionTrace → `decision_trace.jsonl` |
| **replayDumper** | `ps_battle.mjs` | `rawLines` → `tuning/replays/live/*.json` |
| **logAnalyzer** | `tuning/battle_analyzer.mjs` | battle_log + trace → metrics JSON |
| **replayInjector** | `replay_injector.mjs` | replay JSON → divergence report |
| **pstuneCli** | `pstune.mjs` | `analyze` / `export-baseline` / `gate` |

路径根：`packages/server/data-yuanbao/workspaces/task-ib-mpvf5dh8-6070/`

---

## 3. 闭环

```text
ou_auto_battle (--profile active)
  → battle_log.jsonl + decision_trace.jsonl
  → tuning/replays/live/<battleId>.json
  → pstune analyze
  → pstune gate --profile v2-draft
  → tuning_profiles/active.json
  → profile_loader 热加载
```

---

## 4. Profile 格式

```json
{
  "version": "baseline-v1",
  "matchupWeights": { "switchCritical": 100, "...": "..." },
  "engineConstants": { "BP_WEIGHT": 0.02, "SE_BONUS": 2.0 }
}
```

权威 baseline：`tuning_profiles/baseline.json`  
候选：`tuning_profiles/v2-draft.json`（元宝 ee49 提案）

---

## 5. RunReport 扩展（pokemon）

| 指标 | 来源 |
|------|------|
| `matchupHitRate` | decision_trace intercept.triggered |
| `fallbackRate` | battle_log reason=random_fallback |
| `invalidChoiceRate` | battle_log event=invalid_choice |
| `activeProfileVersion` | tuning_profiles/active.json |

---

## 6. 运行

```bash
cd packages/server
node data-yuanbao/workspaces/task-ib-mpvf5dh8-6070/ou_auto_battle.mjs --max-battles 5 --profile tuning_profiles/baseline.json
node data-yuanbao/workspaces/task-ib-mpvf5dh8-6070/pstune.mjs analyze
node data-yuanbao/workspaces/task-ib-mpvf5dh8-6070/pstune.mjs gate --profile tuning_profiles/v2-draft.json
node data-yuanbao/workspaces/task-ib-mpvf5dh8-6070/replay_injector.mjs --matchup-db matchup_rules.json
```

---

## 7. 阶段

| 阶段 | 状态 | 内容 |
|------|------|------|
| P0 | ✅ | ADL、profile、trace、injector 迁入、pstune analyze |
| P1 | ⏳ | log_to_replay 完整化、regression_gate 接 replay 语料 |
| P2 | ⏳ | tuning_proposer 规则版、canary 模式 |
| P3 | ⏳ | RunReport pokemon 指标接入 analyze-run.mjs |
