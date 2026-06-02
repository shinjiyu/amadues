# Resolve Kuroneko monorepo root when scripts run from local-dashboard copy.
function Get-KuronekoRepoRoot {
  if ($env:KURONEKO_ROOT -and (Test-Path $env:KURONEKO_ROOT)) {
    return $env:KURONEKO_ROOT
  }

  $marker = Join-Path $PSScriptRoot 'repo-root.txt'
  if (Test-Path $marker) {
    $fromFile = (Get-Content $marker -Raw).Trim()
    if ($fromFile -and (Test-Path $fromFile)) {
      return $fromFile
    }
  }

  $candidate = (Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue).Path
  if ($candidate -and (Test-Path (Join-Path $candidate 'scripts\local-dashboard\health.ps1'))) {
    return $candidate
  }

  Write-Error @(
    'Cannot resolve Kuroneko repo root.',
    'Run: .\scripts\sync-local-dashboard.ps1 (writes scripts\kuroneko\repo-root.txt),',
    'or set KURONEKO_ROOT to your kuroneko checkout.'
  ) -Separator ' '
  exit 2
}
