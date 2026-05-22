#!/usr/bin/env bash
# 先 stop 再启动 dev（与 package.json 中 npm start 一致）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "${ROOT}/scripts/stop.sh"
cd "${ROOT}"
exec npm run dev
