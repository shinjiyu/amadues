# Amadeus exec-agent · game-eval 2048

Pair with fork experiment:

`~/Documents/sub-private/game-eval/experiments/kurenai-miniagent-vs-cursor/`

## Run

```bash
source ~/Documents/sub-private/game-eval/experiments/kurenai-miniagent-vs-cursor/env.sh
# after prepare.sh:
export GAME_EVAL_WORKDIR="$(python3 -c 'import json; print(json.load(open("…/results/pair.json"))["miniagent"]["agent_workdir"])')"
npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-gamegen-2048.ts
```

Or: `…/run-miniagent.sh`

Progress: `live/` + optional `EXEC_AGENT_PROGRESS_PORT=8934` progress-server.

Act tools: **exec only** (`seed/tools.json` is `[]`).
