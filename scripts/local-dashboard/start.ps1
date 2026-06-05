param(
  [Parameter(Mandatory = $true)]
  [string]$Service,
  [switch]$SkipBuild
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

if ($svc.LocalAgent) {
  . (Join-Path $KuronekoRepoRoot 'scripts\kuroneko\_agent-local.ps1')
  $la = $svc.LocalAgent
  $watch = $false
  if ($la.Watch) { $watch = $true }
  Start-AgentLocalProcess -Name $la.Name -Port ([int]$la.Port) -DataDirRel $la.DataDirRel -Watch:$watch
  exit 0
}

if ($svc.DockerProfile) {
  . (Join-Path $KuronekoRepoRoot 'scripts\kuroneko\_agent-docker.ps1')
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  $wait = if ($svc.StartupWaitSec) { [int]$svc.StartupWaitSec } else { 180 }
  Start-AgentDockerService -Profile $svc.DockerProfile -StartupWaitSec $wait -SkipBuild:$SkipBuild
  exit 0
}

if (-not $svc.NpmScript) {
  Write-Error "Service '$Service' is not configured for Docker or npm"
  exit 1
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

. "$PSScriptRoot\_load-env.ps1"
Import-KuronekoDotEnv -RepoRoot $KuronekoRepoRoot

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

$logDir = Join-Path $KuronekoRepoRoot 'scripts\local-dashboard\.logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "$Service.log"
Set-Content -Path $logFile -Value "[$((Get-Date).ToString('o'))] start $Service -> npm run $($svc.NpmScript)" -Encoding utf8

$argLine = "npm run $($svc.NpmScript) 1>> `"$logFile`" 2>&1"
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $argLine) -WorkingDirectory $KuronekoRepoRoot -WindowStyle Hidden -PassThru

if (-not $p) { exit 1 }
$p.Id | Set-Content -Path $pidFile -Encoding ascii

if (Wait-KuronekoHealthy $svc) {
  exit 0
}

Write-Error "Service '$Service' did not become healthy on port/URL within $($svc.StartupWaitSec)s. See log: $logFile"
exit 1
