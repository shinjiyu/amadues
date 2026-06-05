<#
.SYNOPSIS
  重启全部 Agent：先 stop-all，再 start-all（默认 -SkipBuild 加快启动）。
#>
param([switch]$WithBuild)

& "$PSScriptRoot\stop-all-agents.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($WithBuild) {
  & "$PSScriptRoot\start-all-agents.ps1"
} else {
  & "$PSScriptRoot\start-all-agents.ps1" -SkipBuild
}
exit $LASTEXITCODE
