param([switch]$Watch)
# 本地 tsx 启动 Shiro（与 bot2 相同，使用仓库最新源码，非 Docker 镜像）
. "$PSScriptRoot\_agent-docker.ps1"
. "$PSScriptRoot\_agent-local.ps1"
$root = Get-KuronekoRepoRootForDocker
Ensure-AgentInstanceEnvFile $root 'shiro'
Write-Host '[shiro-local] stop docker + local'
try { docker stop utlra-agent-shiro 2>&1 | Out-Null } catch {}
Stop-AgentLocalProcess -Name shiro -Port 8788
Start-AgentLocalProcess -Name shiro -Port 8788 -DataDirRel 'packages\server\data-shiro' @PSBoundParameters
