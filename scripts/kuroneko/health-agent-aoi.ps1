param()
. "$PSScriptRoot\_agent-docker.ps1"
if (Test-AgentDockerService -Profile 'aoi') { exit 0 }
exit 1
