param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'stop', 'health')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ServiceId
)

$root = if ($env:KURONEKO_ROOT) { $env:KURONEKO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$script = Join-Path $root "scripts\local-dashboard\$Action.ps1"
if (-not (Test-Path $script)) {
  Write-Error "Not found: $script"
  exit 2
}
& $script -Service $ServiceId
exit $LASTEXITCODE
