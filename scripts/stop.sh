#!/usr/bin/env bash
# 释放 utlra 默认开发端口（API + Vite）。可用环境变量覆盖：
#   PORT       默认 8787（与 packages/server 一致）
#   DASH_PORT  默认 5173（与 apps/dashboard/vite.config 一致）

set -euo pipefail

API_PORT="${PORT:-8787}"
DASH_PORT="${DASH_PORT:-5173}"

kill_listeners() {
  local port="$1"
  local name="$2"
  local found=0
  for pid in $(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null); do
    found=1
    echo "[utlra stop] ${name} :${port} -> PID ${pid}"
    kill "${pid}" 2>/dev/null || true
  done
  if [[ "${found}" -eq 1 ]]; then
    sleep 0.4
    for pid in $(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null); do
      echo "[utlra stop] ${name} :${port} 仍占用，SIGKILL PID ${pid}"
      kill -9 "${pid}" 2>/dev/null || true
    done
  else
    echo "[utlra stop] ${name} :${port} 无监听"
  fi
}

kill_listeners "${API_PORT}" "API"
kill_listeners "${DASH_PORT}" "Dashboard"
echo "[utlra stop] 完成"
