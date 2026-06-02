param()
. "$PSScriptRoot\_agent-local.ps1"
Stop-AgentLocalProcess -Name bot2 -Port 8797
& docker stop utlra-agent-bot2 2>$null | Out-Null
