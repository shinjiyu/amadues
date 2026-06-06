# Bot3 = legacy 内脑 worktree（pre-DyFlow @ 55745e50）

function Get-KuronekoLegacyWorktreeRoot {
  $fromEnv = $env:KURONEKO_LEGACY_WORKTREE
  if ($fromEnv) { $fromEnv = $fromEnv.Trim() }
  if ($fromEnv -and (Test-Path $fromEnv)) {
    return (Resolve-Path $fromEnv).Path
  }
  $default = 'D:\kuroneko-legacy'
  if (-not (Test-Path $default)) {
    throw "Legacy worktree not found: $default (set KURONEKO_LEGACY_WORKTREE or run: hutao worktree add D:\kuroneko-legacy 55745e50)"
  }
  return (Resolve-Path $default).Path
}

function Sync-Bot3EnvFromBot2 {
  param(
    [Parameter(Mandatory = $true)][string]$MainRepoRoot,
    [Parameter(Mandatory = $true)][string]$Bot3EnvPath
  )
  $bot2Path = Join-Path (Join-Path $MainRepoRoot 'deploy\agent\env') 'bot2.env'
  if (-not (Test-Path $bot2Path)) {
    throw "Missing bot2.env at $bot2Path"
  }
  $copyKeys = @(
    'UTLRA_INNER_LLM_PROVIDER', 'LOCALMODULE_API_KEY', 'LOCALMODULE_BASE_URL',
    'LOCALMODULE_MODEL', 'LOCALMODULE_VISION_MODEL', 'ZHIPU_API_KEY',
    'DRIVE9_SERVER',
    'WEBCHAT_API_BASE', 'WEBCHAT_WS_URL', 'WEBCHAT_AGENT_SECRET',
    'WEBCHAT_GLOBAL_THREAD_ID', 'WEBCHAT_MIRROR_ASSETS', 'WEBCHAT_TENANT',
    'UTLRA_OUTER_REPLY_LLM', 'UTLRA_OUTER_RUN_INNER', 'UTLRA_OUTER_HEARTBEAT_INTERVAL_MS',
    'UTLRA_OUTER_HEARTBEAT_THREAD_ID', 'UTLRA_KPI_AUTO_NEXT_BURST',
    'UTLRA_OUTER_PROACTIVE_LEVEL', 'UTLRA_OUTER_MAX_AGENT_CHAIN'
  )
  $bot2Map = @{}
  foreach ($line in Get-Content -LiteralPath $bot2Path -Encoding UTF8) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $bot2Map[$k] = $t.Substring($eq + 1).Trim()
  }
  $bot3Fixed = [ordered]@{
    'UTLRA_AGENT_IM_SID' = 'idp:agent:bot3'
    'UTLRA_PRIMARY_AGENT_SID' = 'idp:agent:bot3'
    'UTLRA_AGENT_NAME' = 'Bot3'
    'UTLRA_CHAT_CHANNEL' = 'webchat'
    'WEBCHAT_AGENT_USER_ID' = 'bot3'
    'WEBCHAT_AGENT_DISPLAY_NAME' = 'Bot3'
    'WEBCHAT_PEER_AGENT_USER_IDS' = 'bot2'
  }
  $out = @(
    '# Bot3 legacy inner-brain (worktree 55745e50). LLM synced from bot2.env.',
    '# Do not commit.',
    ''
  )
  foreach ($k in $copyKeys) {
    if ($bot2Map.ContainsKey($k)) {
      $out += "$k=$($bot2Map[$k])"
    }
  }
  $out += ''
  foreach ($k in $bot3Fixed.Keys) {
    $out += "$k=$($bot3Fixed[$k])"
  }
  Set-Content -LiteralPath $Bot3EnvPath -Value $out -Encoding UTF8
}
