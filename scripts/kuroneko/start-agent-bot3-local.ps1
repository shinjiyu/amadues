param([switch]$Watch)
. "$PSScriptRoot\_agent-local.ps1"
. "$PSScriptRoot\_bot3-legacy.ps1"
$main = Get-KuronekoRepoRootForDocker
$legacy = Get-KuronekoLegacyWorktreeRoot
Ensure-AgentInstanceEnvFile $main 'bot3'
Sync-Bot3EnvFromBot2 -MainRepoRoot $main -Bot3EnvPath (Join-Path (Get-AgentEnvDir $main) 'bot3.env')
Start-AgentLocalProcess `
  -Name bot3 `
  -Port 8798 `
  -DataDirRel 'packages\server\data-bot3' `
  -RepoRoot $legacy `
  -EnvRepoRoot $main `
  @PSBoundParameters
