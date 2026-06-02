param([switch]$Watch)
. "$PSScriptRoot\_agent-local.ps1"
Start-AgentLocalProcess -Name bot2 -Port 8797 -DataDirRel 'packages\server\data-bot2' @PSBoundParameters
