function Set-EnvFileLine {
  param(
    [Parameter(Mandatory = $true)][string]$EnvPath,
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $lines = Get-Content -LiteralPath $EnvPath -Encoding UTF8
  $pattern = "^\s*$([regex]::Escape($Key))\s*="
  $newLine = "$Key=$Value"
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match $pattern) {
      $found = $true
      $newLine
    } else {
      $line
    }
  }
  if (-not $found) {
    $out = @($out) + $newLine
  }
  Set-Content -LiteralPath $EnvPath -Value $out -Encoding UTF8
}

function New-Mem9ApiKey {
  $raw = curl.exe -sX POST https://api.mem9.ai/v1alpha1/mem9s
  if (-not $raw) { throw 'mem9: empty response from POST /v1alpha1/mem9s' }
  try {
    $obj = $raw | ConvertFrom-Json
  } catch {
    throw "mem9: invalid JSON: $raw"
  }
  $id = $obj.id
  if (-not $id) { throw "mem9: missing id in response: $raw" }
  return [string]$id
}

function New-Drive9Context {
  param([Parameter(Mandatory = $true)][string]$ContextName)
  $exe = Get-Command drive9 -ErrorAction SilentlyContinue
  if (-not $exe) {
    throw 'drive9 CLI not found on PATH. Install: curl -fsSL https://drive9.ai/install.sh | sh (or Windows binary from drive9.ai/releases)'
  }
  $createOut = & drive9 create --name $ContextName 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "drive9 create failed: $createOut"
  }
  $useOut = & drive9 ctx use $ContextName 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "drive9 ctx use failed: $useOut"
  }
  $cfgPath = Join-Path $env:USERPROFILE '.drive9\config'
  if (-not (Test-Path $cfgPath)) {
    throw "drive9 config missing: $cfgPath"
  }
  $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
  $ctx = $cfg.contexts.$ContextName
  if (-not $ctx -or -not $ctx.api_key) {
    throw "drive9: no api_key for context $ContextName in $cfgPath"
  }
  return [string]$ctx.api_key
}
