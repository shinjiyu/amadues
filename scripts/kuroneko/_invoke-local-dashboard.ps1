param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'stop', 'health')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ServiceId
)

. "$PSScriptRoot\_repo-root.ps1"

$root = Get-KuronekoRepoRoot
$script = Join-Path $root "scripts\local-dashboard\$Action.ps1"
if (-not (Test-Path $script)) {
  Write-Error "Not found: $script (KURONEKO_ROOT=$root)"
  exit 2
}
& $script -Service $ServiceId
exit $LASTEXITCODE
