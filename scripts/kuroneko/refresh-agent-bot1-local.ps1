<#
.SYNOPSIS
  干净重启本地 Bot1：停进程 → 清空 data-bot1 → 新 mem9 + drive9 → 写 bot1.env → 拉起。

.DESCRIPTION
  不猜状态；一键重复「实验前归零」流程。保留 deploy/agent/env/bot1.env 里
  除 MEM9_API_KEY / DRIVE9_API_KEY 外的配置（LLM、webchat secret 等）。

  日志：scripts/local-dashboard/.logs/agent-bot1-local.log
  数据：packages/server/data-bot1/
  文档：doc/deploy/bot1-bot2-webchat-lab.md

.PARAMETER SkipProvision
  不申请新 mem9/drive9，仅停服 + 清缓存 + 重启（沿用 bot1.env 现有 Key）。

.PARAMETER NoStart
  做完停服/清缓存/换 Key 后不启动（便于检查 env）。

.PARAMETER Watch
  启动后 npm run dev（watch 模式），默认 dev:nowatch。

.EXAMPLE
  npm run dev:agent:bot1:fresh

.EXAMPLE
  powershell -File scripts/kuroneko/refresh-agent-bot1-local.ps1 -SkipProvision
#>
param(
  [switch]$SkipProvision,
  [switch]$NoStart,
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\_agent-docker.ps1"
. "$PSScriptRoot\_agent-local.ps1"

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

function Ensure-Bot1EnvDefaults {
  param([Parameter(Mandatory = $true)][string]$EnvPath)
  Set-EnvFileLine -EnvPath $EnvPath -Key 'INNER_BRAIN_ENGINE' -Value 'dyflow'
  Set-EnvFileLine -EnvPath $EnvPath -Key 'INNER_BASE_NODE_MAX_ROUNDS' -Value '50'
  Set-EnvFileLine -EnvPath $EnvPath -Key 'INNER_BASE_NODE_FAIL_FAST_STREAK' -Value '5'
  if (-not (Select-String -LiteralPath $EnvPath -Pattern '^\s*DRIVE9_SERVER=' -Quiet)) {
    Set-EnvFileLine -EnvPath $EnvPath -Key 'DRIVE9_SERVER' -Value 'https://api.drive9.ai'
  }
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

$root = Get-KuronekoRepoRootForDocker
Ensure-AgentInstanceEnvFile $root 'bot1'
$envPath = Join-Path (Get-AgentEnvDir $root) 'bot1.env'

Write-Host '[bot1-fresh] stop'
Stop-AgentLocalProcess -Name bot1 -Port 8796
& docker stop utlra-agent-bot1 2>$null | Out-Null

$dataDir = Join-Path $root 'packages\server\data-bot1'
if (Test-Path $dataDir) {
  Write-Host "[bot1-fresh] clear $dataDir"
  Get-ChildItem -LiteralPath $dataDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
} else {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Write-Host "[bot1-fresh] created $dataDir"
}

if (-not $SkipProvision) {
  Write-Host '[bot1-fresh] provision mem9'
  $mem9 = New-Mem9ApiKey
  $ctxName = 'bot1-fresh-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  Write-Host "[bot1-fresh] provision drive9 context $ctxName"
  $d9 = New-Drive9Context -ContextName $ctxName
  Set-EnvFileLine -EnvPath $envPath -Key 'MEM9_API_KEY' -Value $mem9
  Set-EnvFileLine -EnvPath $envPath -Key 'DRIVE9_API_KEY' -Value $d9
  Write-Host "[bot1-fresh] bot1.env updated (mem9 id=$mem9 drive9 ctx=$ctxName)"
} else {
  Write-Host '[bot1-fresh] SkipProvision: keep existing MEM9/DRIVE9 in bot1.env'
}

Ensure-Bot1EnvDefaults -EnvPath $envPath
Repair-AgentEnvFileContent $envPath
Sync-AgentEnvRootAlias -RepoRoot $root -Name 'bot1'

if ($NoStart) {
  Write-Host '[bot1-fresh] NoStart: done (env + cache ready)'
  exit 0
}

Write-Host '[bot1-fresh] start'
Start-AgentLocalProcess -Name bot1 -Port 8796 -DataDirRel 'packages\server\data-bot1' @PSBoundParameters
Write-Host '[bot1-fresh] ready http://127.0.0.1:8796'
