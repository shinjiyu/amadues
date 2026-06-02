param(
  [Parameter(Mandatory = $true)]
  [string]$Service
)

. "$PSScriptRoot\_services.ps1"
$svc = Get-KuronekoService $Service
$pidFile = Get-KuronekoPidFile $Service

if ($svc.LocalAgent) {
  . (Join-Path $KuronekoRepoRoot 'scripts\kuroneko\_agent-local.ps1')
  $la = $svc.LocalAgent
  Stop-AgentLocalProcess -Name $la.Name -Port ([int]$la.Port)
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  exit 0
}

if ($svc.DockerProfile) {
  . (Join-Path $KuronekoRepoRoot 'scripts\kuroneko\_agent-docker.ps1')
  Stop-AgentDockerService -Profile $svc.DockerProfile
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  exit 0
}

if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($procId) {
    & taskkill.exe /F /T /PID $procId 2>$null | Out-Null
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Stop-KuronekoServicePorts $svc
exit 0
