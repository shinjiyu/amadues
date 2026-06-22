# 重建镜像并重启 Docker 版 webchat agent（kuroneko / gin / aoi / yuanbao）
# 不碰本地 shiro(8788) / bot1 / bot2
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_agent-docker.ps1"
$root = Get-KuronekoRepoRootForDocker

Write-Host '[docker-agents] build utlra/agent-server:latest'
Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @('build')

Write-Host '[docker-agents] recreate kuroneko gin aoi yuanbao'
Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @(
  '--profile', 'kuroneko',
  '--profile', 'gin',
  '--profile', 'aoi',
  '--profile', 'yuanbao',
  'up', '-d', '--force-recreate'
)

$checks = @(
  @{ Profile = 'kuroneko'; Port = 8787 },
  @{ Profile = 'gin'; Port = 8789 },
  @{ Profile = 'aoi'; Port = 8791 },
  @{ Profile = 'yuanbao'; Port = 8793 }
)
$deadline = (Get-Date).AddSeconds(240)
foreach ($c in $checks) {
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-AgentDockerService -Profile $c.Profile) { $ok = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ok) {
    Write-Error "Agent $($c.Profile) not healthy on port $($c.Port)"
    exit 1
  }
  Write-Host "[docker-agents] $($c.Profile) healthy :$($c.Port)"
}
Write-Host '[docker-agents] done'
