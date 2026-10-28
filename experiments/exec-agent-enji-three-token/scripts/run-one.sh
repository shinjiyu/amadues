#!/bin/zsh
set -euo pipefail
EXP_ROOT="${0:A:h:h}"
AMADEUS_ROOT="${AMADEUS_ROOT:-$HOME/Documents/amadues}"
CASE="${CASE:?set CASE=tetris-enji|tetris-three|rubik-enji|rubik-three}"

if [[ -z "${WORKDIR:-}" ]]; then
  ROOT="$(cat "$EXP_ROOT/results/.workdir-root" 2>/dev/null || true)"
  [[ -n "$ROOT" ]] || { print -u2 "missing results/.workdir-root — run prepare.sh first"; exit 2; }
  WORKDIR="$ROOT/$CASE"
fi

OUT="$EXP_ROOT/results/$CASE"
mkdir -p "$OUT" "$OUT/live"
export WORKDIR
export CASE
export EXEC_AGENT_OUT_DIR="$OUT"
export EXEC_AGENT_LIVE_DIR="$OUT/live"
export EXEC_AGENT_EXPERIMENT=exec-agent-enji-three-token
export EXEC_AGENT_MAX_ROUNDS="${EXEC_AGENT_MAX_ROUNDS:-25}"
export EXEC_AGENT_MAX_STEPS="${EXEC_AGENT_MAX_STEPS:-120}"
export EXEC_AGENT_TIMEOUT_MS="${EXEC_AGENT_TIMEOUT_MS:-600000}"

print "==> CASE=$CASE WORKDIR=$WORKDIR OUT=$OUT"

cd "$AMADEUS_ROOT"
# Detach so shell disconnects do not kill the run.
python3 - "$OUT" <<'PY'
import os, subprocess, sys, time
from pathlib import Path
out = Path(sys.argv[1])
log = open(out / "run.log", "a")
err = open(out / "run.err", "a")
log.write(f"\n--- start {time.strftime('%Y-%m-%dT%H:%M:%S')} case={os.environ.get('CASE')} ---\n")
log.flush()
p = subprocess.Popen(
    ["node", "--import", "tsx", "packages/server/src/openkuroneko/exec-agent/run-enji-three-token.ts"],
    cwd=os.environ.get("AMADEUS_ROOT") or os.getcwd(),
    env=os.environ.copy(),
    stdout=log,
    stderr=err,
    start_new_session=True,
)
(out / "pid").write_text(f"{p.pid}\n")
print(f"[run-one] detached pid={p.pid}")
PY
