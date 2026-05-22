param(
  [Parameter(Mandatory = $true)]
  [string]$Service
)

. "$PSScriptRoot\_services.ps1"
$svc = Get-KuronekoService $Service
$pidFile = Get-KuronekoPidFile $Service

if (-not (Test-Path $KuronekoRepoRoot)) {
  Write-Error "KURONEKO_ROOT not found: $KuronekoRepoRoot"
  exit 1
}

if (Test-KuronekoHealth $svc) {
  exit 0
}

if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid) {
    & taskkill.exe /F /T /PID $oldPid 2>$null | Out-Null
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Stop-KuronekoServicePorts $svc

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) {
  Write-Error 'npm not found in PATH'
  exit 1
}

# cmd /c 保持 npm 脚本（含 && 预构建）在 Windows 上可靠执行
$argLine = "npm run $($svc.NpmScript)"
$p = Start-Process -FilePath 'cmd.exe' `
  -ArgumentList @('/c', $argLine) `
  -WorkingDirectory $KuronekoRepoRoot `
  -WindowStyle Hidden `
  -PassThru

if (-not $p) { exit 1 }
$p.Id | Set-Content -Path $pidFile -Encoding ascii

if (Wait-KuronekoHealthy $svc) {
  exit 0
}

Write-Error "Service '$Service' did not become healthy on port/URL within $($svc.StartupWaitSec)s"
exit 1
