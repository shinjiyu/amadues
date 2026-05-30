function Import-KuronekoDotEnv {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)

  $envFile = Join-Path $RepoRoot '.env.kuroneko'
  if (-not (Test-Path $envFile)) {
    $envFile = Join-Path $RepoRoot '.env'
  }
  if (-not (Test-Path $envFile)) { return }

  foreach ($raw in Get-Content $envFile) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $line.Substring(0, $eq).Trim()
    if (-not $name) { continue }
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2) {
      $first = $value[0]
      $last = $value[$value.Length - 1]
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    Set-Item -Path "Env:$name" -Value $value
  }
}
