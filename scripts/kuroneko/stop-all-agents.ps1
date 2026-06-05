<#
.SYNOPSIS
  停掉全部 Agent：Docker（all + yuanbao + bot1 + bot2）+ 本地 bot1/bot2/yuanbao 进程。
#>
param()

$ErrorActionPreference = 'Continue'

. "$PSScriptRoot\_agent-docker.ps1"
. "$PSScriptRoot\_agent-local.ps1"

$root = Get-KuronekoRepoRootForDocker

Write-Host '[agents] stop local processes'
foreach ($pair in @(
    @{ Name = 'bot1'; Port = 8796 },
    @{ Name = 'bot2'; Port = 8797 },
    @{ Name = 'yuanbao'; Port = 8793 }
)) {
  Stop-AgentLocalProcess -Name $pair.Name -Port $pair.Port
}

Write-Host '[agents] stop docker containers'
$containers = @(
  'utlra-agent-kuroneko',
  'utlra-agent-shiro',
  'utlra-agent-gin',
  'utlra-agent-aoi',
  'utlra-agent-yuanbao',
  'utlra-agent-bot1',
  'utlra-agent-bot2'
)
foreach ($c in $containers) {
  & docker stop $c 2>$null | Out-Null
}

Push-Location (Join-Path $root 'deploy\agent')
foreach ($profile in @('all', 'yuanbao', 'bot1', 'bot2')) {
  & docker compose -f docker-compose.agent.yml --profile $profile stop 2>&1 | Out-Null
}
Pop-Location

Write-Host '[agents] all stopped'
