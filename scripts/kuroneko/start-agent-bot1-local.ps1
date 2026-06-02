param([switch]$Watch)
. "$PSScriptRoot\_agent-local.ps1"
Start-AgentLocalProcess -Name bot1 -Port 8796 -DataDirRel 'packages\server\data-bot1' @PSBoundParameters
