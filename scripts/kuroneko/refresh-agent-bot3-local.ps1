<#
.SYNOPSIS
  干净重启本地 Bot3（legacy worktree）：停进程 → 清空 data-bot3 → 从 bot2 同步 LLM → 可选新 mem9/drive9 → 拉起。

.PARAMETER SkipProvision
  不申请新 mem9/drive9，沿用 bot3.env 现有 Key。

.PARAMETER NoStart
  清缓存后不启动。

.PARAMETER Watch
  dev watch 模式。
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
. "$PSScriptRoot\_bot3-legacy.ps1"

$main = Get-KuronekoRepoRootForDocker
$legacy = Get-KuronekoLegacyWorktreeRoot
$envPath = Join-Path (Get-AgentEnvDir $main) 'bot3.env'
if (-not (Test-Path $envPath)) {
  Copy-Item (Join-Path (Get-AgentEnvDir $main) 'bot3.env.example') $envPath
  Write-Host '[bot3-fresh] created bot3.env from example'
}

Write-Host '[bot3-fresh] stop'
Stop-AgentLocalProcess -Name bot3 -Port 8798
try { & docker stop utlra-agent-bot3 2>&1 | Out-Null } catch { }

$dataDir = Join-Path $legacy 'packages\server\data-bot3'
if (Test-Path $dataDir) {
  Write-Host "[bot3-fresh] clear $dataDir"
  Get-ChildItem -LiteralPath $dataDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
} else {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Write-Host "[bot3-fresh] created $dataDir"
}

Write-Host '[bot3-fresh] sync LLM from bot2.env (mem9/drive9 excluded)'
Sync-Bot3EnvFromBot2 -MainRepoRoot $main -Bot3EnvPath $envPath

if (-not $SkipProvision) {
  Write-Host '[bot3-fresh] provision mem9'
  $mem9 = New-Mem9ApiKey
  $ctxName = 'bot3-fresh-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  Write-Host "[bot3-fresh] provision drive9 context $ctxName"
  $d9 = New-Drive9Context -ContextName $ctxName
  Set-EnvFileLine -EnvPath $envPath -Key 'MEM9_API_KEY' -Value $mem9
  Set-EnvFileLine -EnvPath $envPath -Key 'DRIVE9_API_KEY' -Value $d9
  Write-Host "[bot3-fresh] bot3.env updated (mem9 id=$mem9 drive9 ctx=$ctxName)"
} else {
  Write-Host '[bot3-fresh] SkipProvision: keep existing MEM9/DRIVE9 in bot3.env'
}

Repair-AgentEnvFileContent $envPath
Sync-AgentEnvRootAlias -RepoRoot $main -Name 'bot3'

if (-not (Test-Path (Join-Path $legacy 'node_modules'))) {
  Write-Host '[bot3-fresh] npm install in legacy worktree (first time)...'
  Push-Location $legacy
  try {
    npm install 2>&1 | Write-Host
  } finally {
    Pop-Location
  }
}
$chatIrDist = Join-Path $legacy 'packages\chat-ir\dist\index.js'
if (-not (Test-Path $chatIrDist)) {
  Write-Host '[bot3-fresh] build legacy workspace packages (chat-ir, bridges)...'
  Push-Location $legacy
  try {
    npm run build -w @utlra/chat-ir 2>&1 | Write-Host
    npm run build -w @utlra/discord-bridge 2>&1 | Write-Host
    npm run build -w @utlra/webchat-protocol 2>&1 | Write-Host
    npm run build -w @utlra/webchat-bridge 2>&1 | Write-Host
  } finally {
    Pop-Location
  }
}

if ($NoStart) {
  Write-Host '[bot3-fresh] NoStart: done'
  exit 0
}

Write-Host '[bot3-fresh] start legacy engine on port 8798'
$startArgs = @{
  Name        = 'bot3'
  Port        = 8798
  DataDirRel  = 'packages\server\data-bot3'
  RepoRoot    = $legacy
  EnvRepoRoot = $main
}
if ($Watch) { $startArgs['Watch'] = $true }
Start-AgentLocalProcess @startArgs
Write-Host '[bot3-fresh] ready http://127.0.0.1:8798 (legacy @' $legacy ')'
