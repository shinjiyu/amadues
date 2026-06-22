#!/usr/bin/env bash
# 每日重启 login-backend / login-frontend，缓解 Gunicorn worker 僵死。
# 安装：deploy/ops/install-loginserver-daily-restart.sh
set -euo pipefail

LOG_TAG="[loginserver-daily-restart]"
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

echo "$(ts) $LOG_TAG start"

if ! docker ps --format '{{.Names}}' | grep -qx 'login-backend'; then
  echo "$(ts) $LOG_TAG ERROR: login-backend container not found" >&2
  exit 1
fi

docker restart login-backend login-frontend

for i in $(seq 1 30); do
  if curl -sf --max-time 5 http://127.0.0.1:5001/health >/dev/null 2>&1; then
    echo "$(ts) $LOG_TAG ok backend healthy (~$((i * 2))s)"
    exit 0
  fi
  sleep 2
done

echo "$(ts) $LOG_TAG ERROR: backend still unhealthy after restart" >&2
exit 1
