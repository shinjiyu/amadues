#!/bin/bash
# 安装审计收集器（需 sudo）。ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md §6 监控隔离
#
#   sudo ./deploy/audit/install.sh
#
# 结果：
#   - 系统用户 _amaudit（无登录 shell、隐藏）
#   - /usr/local/libexec/amadues-audit/  收集器与校验器（root 拥有，agent 不可改）
#   - /private/var/amadues-audit/log     日志（_amaudit 0700，agent 不可读写）
#   - /private/var/amadues-audit/run/audit.sock  agent 只能往这里追加事件
#   - /Library/LaunchDaemons/ai.amadues.audit.plist  系统级守护，agent 用户杀不掉
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "需要 root：sudo $0" >&2
  exit 1
fi

AUDIT_USER=_amaudit
LABEL=ai.amadues.audit
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBEXEC=/usr/local/libexec/amadues-audit
ROOT=/private/var/amadues-audit
PLIST=/Library/LaunchDaemons/${LABEL}.plist

if ! dscl . -read /Users/${AUDIT_USER} >/dev/null 2>&1; then
  uid=""
  for candidate in $(seq 450 499); do
    if ! dscl . -search /Users UniqueID "$candidate" | grep -q UniqueID && \
       ! dscl . -search /Groups PrimaryGroupID "$candidate" | grep -q PrimaryGroupID; then
      uid=$candidate; break
    fi
  done
  [[ -n "$uid" ]] || { echo "找不到空闲 UID(450-499)" >&2; exit 1; }
  dscl . -create /Groups/${AUDIT_USER}
  dscl . -create /Groups/${AUDIT_USER} PrimaryGroupID "$uid"
  dscl . -create /Users/${AUDIT_USER}
  dscl . -create /Users/${AUDIT_USER} UniqueID "$uid"
  dscl . -create /Users/${AUDIT_USER} PrimaryGroupID "$uid"
  dscl . -create /Users/${AUDIT_USER} UserShell /usr/bin/false
  dscl . -create /Users/${AUDIT_USER} NFSHomeDirectory /var/empty
  dscl . -create /Users/${AUDIT_USER} RealName "Amadues Audit"
  dscl . -create /Users/${AUDIT_USER} IsHidden 1
  dscl . -create /Users/${AUDIT_USER} Password '*'
  echo "created user ${AUDIT_USER} uid=${uid}"
fi

install -d -o root -g wheel -m 0755 "$LIBEXEC"
install -o root -g wheel -m 0755 "$SRC_DIR/audit_collector.py" "$LIBEXEC/audit_collector.py"
install -o root -g wheel -m 0755 "$SRC_DIR/audit_verify.py" "$LIBEXEC/audit_verify.py"

install -d -o ${AUDIT_USER} -g ${AUDIT_USER} -m 0711 "$ROOT"
install -d -o ${AUDIT_USER} -g ${AUDIT_USER} -m 0700 "$ROOT/log"
install -d -o ${AUDIT_USER} -g ${AUDIT_USER} -m 0755 "$ROOT/run"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>UserName</key><string>${AUDIT_USER}</string>
  <key>GroupName</key><string>${AUDIT_USER}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>${LIBEXEC}/audit_collector.py</string>
    <string>--root</string><string>${ROOT}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${ROOT}/collector.out</string>
  <key>StandardErrorPath</key><string>${ROOT}/collector.err</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"
chmod 0644 "$PLIST"

launchctl bootout system/${LABEL} 2>/dev/null || true
launchctl bootstrap system "$PLIST"

for _ in $(seq 1 20); do
  [[ -S "$ROOT/run/audit.sock" ]] && break
  sleep 0.5
done
if [[ -S "$ROOT/run/audit.sock" ]]; then
  echo "OK: collector running, socket $ROOT/run/audit.sock"
  echo "在 agent env 文件里加：UTLRA_AUDIT_SOCKET=$ROOT/run/audit.sock，然后重启 agent"
else
  echo "collector 未起来，看 $ROOT/collector.err" >&2
  exit 1
fi
