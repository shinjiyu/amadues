<#
.SYNOPSIS
  重建 utlra/agent-server:latest（DyFlow 单引擎源码）。不启动容器。
#>
param()

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_agent-docker.ps1"

$root = Get-KuronekoRepoRootForDocker
Write-Host '[agents] docker build utlra/agent-server:latest (DyFlow)'
Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @('build')
Write-Host '[agents] image ready: utlra/agent-server:latest'
