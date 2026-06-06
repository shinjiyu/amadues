<#
.SYNOPSIS
  干净重启本地 Bot2：停进程 → 清空 data-bot2 → 新 mem9 + drive9 → 写 bot2.env → 拉起。

.DESCRIPTION
  不猜状态；一键重复「实验前归零」流程。保留 deploy/agent/env/bot2.env 里
  除 MEM9_API_KEY / DRIVE9_API_KEY 外的配置（LLM、webchat secret 等）。

  日志：scripts/local-dashboard/.logs/agent-bot2-local.log
  数据：packages/server/data-bot2/
  文档：doc/deploy/bot1-bot2-webchat-lab.md

.PARAMETER SkipProvision
  不申请新 mem9/drive9，仅停服 + 清缓存 + 重启（沿用 bot2.env 现有 Key）。

.PARAMETER NoStart
  做完停服/清缓存/换 Key 后不启动（便于检查 env）。

.PARAMETER Watch
  启动后 npm run dev（watch 模式），默认 dev:nowatch。

.EXAMPLE
  npm run dev:agent:bot2:fresh

.EXAMPLE
  powershell -File scripts/kuroneko/refresh-agent-bot2-local.ps1 -SkipProvision
#>
param(
  [switch]$SkipProvision,
  [switch]$NoStart,
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\_agent-docker.ps1"
. "$PSScriptRoot\_agent-local.ps1"
. "$PSScriptRoot\_agent-provision.ps1"

function Ensure-Bot2EnvDefaults {
  param([Parameter(Mandatory = $true)][string]$EnvPath)
  Set-EnvFileLine -EnvPath $EnvPath -Key 'INNER_BASE_NODE_MAX_ROUNDS' -Value '50'
  Set-EnvFileLine -EnvPath $EnvPath -Key 'INNER_BASE_NODE_FAIL_FAST_STREAK' -Value '5'
  Set-EnvFileLine -EnvPath $EnvPath -Key 'INNER_ATTRIBUTOR_MAX_ROUNDS' -Value '20'
  Set-EnvFileLine -EnvPath $EnvPath -Key 'INNER_DESIGNER_MAX_ROUNDS' -Value '20'
  if (-not (Select-String -LiteralPath $EnvPath -Pattern '^\s*DRIVE9_SERVER=' -Quiet)) {
    Set-EnvFileLine -EnvPath $EnvPath -Key 'DRIVE9_SERVER' -Value 'https://api.drive9.ai'
  }
}

$root = Get-KuronekoRepoRootForDocker
Ensure-AgentInstanceEnvFile $root 'bot2'
$envPath = Join-Path (Get-AgentEnvDir $root) 'bot2.env'

Write-Host '[bot2-fresh] stop'
Stop-AgentLocalProcess -Name bot2 -Port 8797
try { & docker stop utlra-agent-bot2 2>&1 | Out-Null } catch { }

$dataDir = Join-Path $root 'packages\server\data-bot2'
if (Test-Path $dataDir) {
  Write-Host "[bot2-fresh] clear $dataDir"
  Get-ChildItem -LiteralPath $dataDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
} else {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Write-Host "[bot2-fresh] created $dataDir"
}

if (-not $SkipProvision) {
  Write-Host '[bot2-fresh] provision mem9'
  $mem9 = New-Mem9ApiKey
  $ctxName = 'bot2-fresh-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  Write-Host "[bot2-fresh] provision drive9 context $ctxName"
  $d9 = New-Drive9Context -ContextName $ctxName
  Set-EnvFileLine -EnvPath $envPath -Key 'MEM9_API_KEY' -Value $mem9
  Set-EnvFileLine -EnvPath $envPath -Key 'DRIVE9_API_KEY' -Value $d9
  Write-Host "[bot2-fresh] bot2.env updated (mem9 id=$mem9 drive9 ctx=$ctxName)"
} else {
  Write-Host '[bot2-fresh] SkipProvision: keep existing MEM9/DRIVE9 in bot2.env'
}

Ensure-Bot2EnvDefaults -EnvPath $envPath
Repair-AgentEnvFileContent $envPath
Sync-AgentEnvRootAlias -RepoRoot $root -Name 'bot2'

if ($NoStart) {
  Write-Host '[bot2-fresh] NoStart: done (env + cache ready)'
  exit 0
}

Write-Host '[bot2-fresh] start'
$startArgs = @{
  Name       = 'bot2'
  Port       = 8797
  DataDirRel = 'packages\server\data-bot2'
}
if ($Watch) { $startArgs['Watch'] = $true }
Start-AgentLocalProcess @startArgs
Write-Host '[bot2-fresh] ready http://127.0.0.1:8797'
