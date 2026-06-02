# 将 Kuroneko 服务表 + 启停脚本同步到本机 local-dashboard，并执行 merge 写入 registry.json
# 用法（仓库根）：
#   .\scripts\sync-local-dashboard.ps1
#   .\scripts\sync-local-dashboard.ps1 -LocalDashboardRoot D:\UGit\-local_dashborad

param(
  [string]$LocalDashboardRoot = $(if ($env:LOCAL_DASHBOARD_ROOT) { $env:LOCAL_DASHBOARD_ROOT } else { 'D:\UGit\-local_dashborad' })
)

$ErrorActionPreference = 'Stop'
$KuronekoRoot = if ($env:KURONEKO_ROOT) { $env:KURONEKO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

if (-not (Test-Path $LocalDashboardRoot)) {
  Write-Error "local-dashboard not found: $LocalDashboardRoot. Set -LocalDashboardRoot or LOCAL_DASHBOARD_ROOT."
  exit 1
}

$mergeScript = Join-Path $LocalDashboardRoot 'scripts\merge-kuroneko-bundle.mjs'
if (-not (Test-Path $mergeScript)) {
  Write-Error "merge script not found: $mergeScript"
  exit 1
}

$destScripts = Join-Path $LocalDashboardRoot 'scripts\kuroneko'
New-Item -ItemType Directory -Force -Path $destScripts | Out-Null

Copy-Item -Force (Join-Path $KuronekoRoot 'scripts\kuroneko-utlra.bundle.json') (Join-Path $LocalDashboardRoot 'scripts\kuroneko-utlra.bundle.json')
Copy-Item -Force (Join-Path $KuronekoRoot 'scripts\kuroneko\*.ps1') $destScripts

$repoRootFile = Join-Path $destScripts 'repo-root.txt'
Set-Content -Path $repoRootFile -Value $KuronekoRoot -Encoding ascii -NoNewline
Write-Host "[sync] repo   -> $repoRootFile ($KuronekoRoot)"

Write-Host "[sync] bundle -> $LocalDashboardRoot\scripts\kuroneko-utlra.bundle.json"
Write-Host "[sync] ps1    -> $destScripts"

Push-Location $LocalDashboardRoot
try {
  $env:KURONEKO_ROOT = $KuronekoRoot
  node $mergeScript
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  # 反注册：从 registry 移除 bundle 中已删除的 kuroneko-* 服务
  $registryPath = Join-Path $LocalDashboardRoot 'registry.json'
  $bundlePath = Join-Path $KuronekoRoot 'scripts\kuroneko-utlra.bundle.json'
  node -e @"
const fs = require('fs');
const registryPath = process.argv[1];
const bundlePath = process.argv[2];
if (!fs.existsSync(registryPath)) process.exit(0);
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
const validIds = new Set(bundle.services.map((s) => s.id));
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const before = registry.services.length;
registry.services = registry.services.filter(
  (s) => !s.id.startsWith('kuroneko-') || validIds.has(s.id),
);
if (registry.services.length < before) {
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log('[sync] pruned ' + (before - registry.services.length) + ' removed kuroneko service(s) from registry');
}
"@ $registryPath $bundlePath
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host ""
  Write-Host "Done. Open http://127.0.0.1:9780/?page=kuroneko"
  Write-Host "If 9780 is down, run .\start.ps1 in local-dashboard root."
} finally {
  Pop-Location
}
