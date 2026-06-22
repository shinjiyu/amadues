#!/usr/bin/env bash
# 在 CVM 上安装 loginserver 每日重启 cron（默认 04:00 北京时间）
set -euo pipefail

SCRIPT_SRC="${1:-$(dirname "$0")/loginserver-daily-restart.sh}"
TARGET="/opt/loginserver/scripts/daily-restart.sh"
CRON_HOUR="${LOGINSERVER_RESTART_HOUR:-4}"
CRON_MIN="${LOGINSERVER_RESTART_MIN:-0}"
LOG="/var/log/kuroneko-loginserver-restart.log"
MARKER="kuroneko-loginserver-daily-restart"

if [ ! -f "$SCRIPT_SRC" ]; then
  echo "ERROR: missing $SCRIPT_SRC" >&2
  exit 1
fi

mkdir -p /opt/loginserver/scripts
install -m 755 "$SCRIPT_SRC" "$TARGET"
touch "$LOG"
chmod 644 "$LOG"

CRON_LINE="$CRON_MIN $CRON_HOUR * * * $TARGET >> $LOG 2>&1 # $MARKER"

( crontab -l 2>/dev/null | grep -v "$MARKER" || true
  echo "$CRON_LINE"
) | crontab -

echo "Installed $TARGET"
echo "Cron: $CRON_LINE"
crontab -l | grep "$MARKER" || true
