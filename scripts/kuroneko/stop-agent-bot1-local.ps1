param()
. "$PSScriptRoot\_agent-local.ps1"
Stop-AgentLocalProcess -Name bot1 -Port 8796
& docker stop utlra-agent-bot1 2>$null | Out-Null
