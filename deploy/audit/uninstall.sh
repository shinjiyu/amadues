#!/bin/bash
# 卸载审计收集器（需 sudo）。默认保留日志；加 --purge 连日志与 _amaudit 用户一起删。
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "需要 root：sudo $0" >&2; exit 1; }

LABEL=ai.amadues.audit
launchctl bootout system/${LABEL} 2>/dev/null || true
rm -f /Library/LaunchDaemons/${LABEL}.plist
rm -rf /usr/local/libexec/amadues-audit
if [[ "${1:-}" == "--purge" ]]; then
  rm -rf /private/var/amadues-audit
  dscl . -delete /Users/_amaudit 2>/dev/null || true
  dscl . -delete /Groups/_amaudit 2>/dev/null || true
  echo "purged"
else
  echo "removed daemon; logs kept in /private/var/amadues-audit"
fi
