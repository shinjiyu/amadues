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

Write-Host "[sync] bundle -> $LocalDashboardRoot\scripts\kuroneko-utlra.bundle.json"
Write-Host "[sync] ps1    -> $destScripts"

Push-Location $LocalDashboardRoot
try {
  $env:KURONEKO_ROOT = $KuronekoRoot
  node $mergeScript
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ""
  Write-Host "Done. Open http://127.0.0.1:9780/?page=kuroneko"
  Write-Host "If 9780 is down, run .\start.ps1 in local-dashboard root."
} finally {
  Pop-Location
}
