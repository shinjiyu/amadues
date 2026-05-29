param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'stop', 'health')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ServiceId
)

function Get-KuronekoRepoRoot {
  if ($env:KURONEKO_ROOT -and (Test-Path $env:KURONEKO_ROOT)) {
    return $env:KURONEKO_ROOT
  }
  $candidate = (Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue).Path
  if ($candidate -and (Test-Path (Join-Path $candidate 'scripts\local-dashboard\health.ps1'))) {
    return $candidate
  }
  return 'D:\kuroneko'
}

$root = Get-KuronekoRepoRoot
$script = Join-Path $root "scripts\local-dashboard\$Action.ps1"
if (-not (Test-Path $script)) {
  Write-Error "Not found: $script (KURONEKO_ROOT=$root)"
  exit 2
}
& $script -Service $ServiceId
exit $LASTEXITCODE
