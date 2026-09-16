# Collatz（3n+1）· Lean · Harness-RSI 最小 loop

开放猜想 + `lake build` 工艺门控。ADL：[`doc/structurizr/COLLATZ-LEAN-RSI.md`](../../doc/structurizr/COLLATZ-LEAN-RSI.md)

## 依赖

- Lean 4.14 + `lake`（本机：`~/.elan/toolchains/leanprover--lean4---v4.14.0/bin`）
- Node（仓库已有 `~/tools/node`）
- 可选：`deploy/agent/env/collatz-lean.env`（智谱，已 gitignore）

## 跑

```bash
export PATH="$HOME/.elan/toolchains/leanprover--lean4---v4.14.0/bin:$HOME/tools/node/bin:$PATH"
cd experiments/collatz-lean-rsi
lake build                          # 应绿；conjecture 可 sorry
npx --yes tsx run-loop.ts --rounds=3 --interval=1
```

无工具链时可用 `--dry-lake`。`--interval=1` 便于试点观察 cadence（默认 harness 为 3）。
