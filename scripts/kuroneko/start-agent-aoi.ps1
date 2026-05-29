param()
. "$PSScriptRoot\_agent-docker.ps1"
Start-AgentDockerService -Profile 'aoi' -StartupWaitSec 180
