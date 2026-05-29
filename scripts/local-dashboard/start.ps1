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

# 父 shell 若残留 agent 专用变量（如 Cursor 会话），会盖过各 agent 的 --env-file / .env。
# 启动前清掉，让 dev:agent2 / dev:gin / dev:aoi 的 --env-file 与 index.ts dotenv 按预期生效。
Remove-Item Env:UTLRA_DATA_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:LOCALMODULE_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ZHIPU_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:UTLRA_INNER_LLM_PROVIDER -ErrorAction SilentlyContinue
if ($svc.Port) {
  $env:PORT = [string]$svc.Port
} else {
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
}

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
