# Collatz（3n+1）· 证明任务 + RSI 旁路

**任务目标：证明 `Collatz.conjecture`（无 `sorry`）。**  
Harness-RSI 只修 loop 工具故障，**不算**证明进展。

ADL：[`doc/structurizr/COLLATZ-LEAN-RSI.md`](../../doc/structurizr/COLLATZ-LEAN-RSI.md)

## 跑

```bash
export PATH="$HOME/.elan/toolchains/leanprover--lean4---v4.14.0/bin:$HOME/tools/node/bin:$PATH"
set -a && source ../../deploy/agent/env/collatz-lean.env && set +a
cd experiments/collatz-lean-rsi
lake build
npx --yes tsx assault-loop.ts --rounds=5
```

日志：`.brain/proof-journal.jsonl`（`track=proof|rsi` 分开）。
