<#
.SYNOPSIS
  启动全部 Agent：Docker（kuroneko/shiro/gin/aoi/yuanbao）+ 本地（bot1/bot2）。
#>
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Continue'

$root = if ($env:KURONEKO_ROOT) { $env:KURONEKO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$startScript = Join-Path $root 'scripts\local-dashboard\start.ps1'

$services = @(
  'agent-kuroneko',
  'agent-shiro',
  'agent-gin',
  'agent-aoi',
  'agent-yuanbao',
  'agent-bot1',
  'agent-bot2'
)

if (-not $SkipBuild) {
  Write-Host '[agents] docker build (optional; failure still tries up with existing image)'
  . "$PSScriptRoot\_agent-docker.ps1"
  Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @('build')
  if ($LASTEXITCODE -ne 0) {
    Write-Warning '[agents] docker build failed; starting with existing image'
  }
}

$failed = @()
foreach ($svc in $services) {
  Write-Host "[agents] starting $svc ..."
  $skipArg = @{}
  if ($SkipBuild) { $skipArg['SkipBuild'] = $true }
  & $startScript -Service $svc @skipArg
  if ($LASTEXITCODE -ne 0) {
    $failed += $svc
    Write-Warning "[agents] $svc did not become healthy"
  } else {
    Write-Host "[agents] $svc ok"
  }
}

if ($failed.Count -gt 0) {
  Write-Warning "[agents] failed: $($failed -join ', ')"
  exit 1
}
Write-Host '[agents] all started'
