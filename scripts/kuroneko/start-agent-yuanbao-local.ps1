param([switch]$Watch)
. "$PSScriptRoot\_agent-local.ps1"
Start-AgentLocalProcess -Name yuanbao -Port 8793 -DataDirRel 'packages\server\data-yuanbao' @PSBoundParameters
