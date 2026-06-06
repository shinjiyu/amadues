param()
. "$PSScriptRoot\_agent-local.ps1"
Stop-AgentLocalProcess -Name bot3 -Port 8798
try { & docker stop utlra-agent-bot3 2>&1 | Out-Null } catch { }
