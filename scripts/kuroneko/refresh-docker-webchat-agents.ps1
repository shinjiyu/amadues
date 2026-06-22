# 清空 kuroneko / gin / aoi / yuanbao 本地 data → 重建镜像并重启 Docker
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_agent-docker.ps1"
$root = Get-KuronekoRepoRootForDocker

Write-Host '[fresh-docker] stop kuroneko gin aoi yuanbao'
Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @(
  '--profile', 'kuroneko',
  '--profile', 'gin',
  '--profile', 'aoi',
  '--profile', 'yuanbao',
  'stop'
)

$dirs = @(
  @{ Name = 'kuroneko'; Rel = 'packages\server\data' },
  @{ Name = 'gin'; Rel = 'packages\server\data-gin' },
  @{ Name = 'aoi'; Rel = 'packages\server\data-aoi' },
  @{ Name = 'yuanbao'; Rel = 'packages\server\data-yuanbao' }
)
foreach ($d in $dirs) {
  $dataDir = Join-Path $root $d.Rel
  if (Test-Path $dataDir) {
    Write-Host "[fresh-docker] clear $($d.Name) -> $dataDir"
    Get-ChildItem -LiteralPath $dataDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Write-Host "[fresh-docker] created $($d.Name) -> $dataDir"
  }
}

& "$PSScriptRoot\rebuild-restart-docker-webchat-agents.ps1"
