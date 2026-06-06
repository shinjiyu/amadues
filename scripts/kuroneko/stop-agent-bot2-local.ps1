param()
. "$PSScriptRoot\_agent-local.ps1"
Stop-AgentLocalProcess -Name bot2 -Port 8797
try { & docker stop utlra-agent-bot2 2>&1 | Out-Null } catch { }
