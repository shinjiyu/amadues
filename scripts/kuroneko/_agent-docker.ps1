# Agent Docker 启停 — 每人 deploy/agent/env/<name>.env（不入库）

. "$PSScriptRoot\_repo-root.ps1"

function Get-KuronekoRepoRootForDocker {
  Get-KuronekoRepoRoot
}

function Get-AgentEnvDir([string]$RepoRoot) {
  Join-Path $RepoRoot 'deploy\agent\env'
}

function Get-AgentDockerComposeFile([string]$RepoRoot) {
  Join-Path $RepoRoot 'deploy\agent\docker-compose.agent.yml'
}

$script:AgentLegacyEnvMap = @{
  kuroneko = '.env.kuroneko'
  shiro    = '.env.shiro'
  gin      = '.env.gin'
  aoi      = '.env.aoi'
  yuanbao  = '.env.yuanbao'
  bot1     = '.env.bot1'
  bot2     = '.env.bot2'
}

# Legacy root env filenames (migrated once into .env.<agent>)
$script:AgentObsoleteRootEnvMap = @{
  kuroneko = '.env'
  shiro    = '.env.agent2'
}

function Sync-AgentEnvRootAlias {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $src = Join-Path (Get-AgentEnvDir $RepoRoot) "$Name.env"
  if (-not (Test-Path $src)) { return }
  Copy-Item -Force $src (Join-Path $RepoRoot ".env.$Name")
}

function Repair-AgentEnvFileContent([string]$EnvPath) {
  if (-not (Test-Path $EnvPath)) { return }
  $lines = Get-Content $EnvPath
  $out = foreach ($line in $lines) {
    if ($line -match '^(PORT|UTLRA_DATA_ROOT)=') { continue }
    $line
  }
  Set-Content -Path $EnvPath -Value $out -Encoding utf8
}

function Ensure-AgentInstanceEnvFile([string]$RepoRoot, [string]$Name) {
  $dir = Get-AgentEnvDir $RepoRoot
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $envPath = Join-Path $dir "$Name.env"
  $examplePath = Join-Path $dir "$Name.env.example"
  if (-not (Test-Path $envPath)) {
    $legacy = $script:AgentLegacyEnvMap[$Name]
    $legacyPath = if ($legacy) { Join-Path $RepoRoot $legacy } else { $null }
    $obsolete = $script:AgentObsoleteRootEnvMap[$Name]
    $obsoletePath = if ($obsolete) { Join-Path $RepoRoot $obsolete } else { $null }
    if ($legacyPath -and (Test-Path $legacyPath)) {
      Copy-Item $legacyPath $envPath
      Write-Warning "已从 $legacy 迁移到 deploy/agent/env/$Name.env"
    } elseif ($obsoletePath -and (Test-Path $obsoletePath)) {
      Copy-Item $obsoletePath $envPath
      Write-Warning "已从旧版 $obsolete 迁移到 deploy/agent/env/$Name.env"
    } elseif (Test-Path $examplePath) {
      Copy-Item $examplePath $envPath
      Write-Warning "已创建 deploy/agent/env/$Name.env — 请填入 ZHIPU_API_KEY 与 WEBCHAT_AGENT_SECRET"
    } else {
      Write-Error "缺少 $envPath（无 example 可复制）"
      exit 1
    }
  }
  Repair-AgentEnvFileContent $envPath
  Sync-AgentEnvRootAlias -RepoRoot $RepoRoot -Name $Name
}

function Ensure-AllAgentEnvFiles([string]$RepoRoot) {
  foreach ($name in @('kuroneko', 'shiro', 'gin', 'aoi')) {
    Ensure-AgentInstanceEnvFile $RepoRoot $name
  }
}

function Invoke-AgentDockerCompose {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string[]]$ComposeArgs
  )
  $composeFile = Get-AgentDockerComposeFile $RepoRoot
  if (-not (Test-Path $composeFile)) {
    Write-Error "Missing compose file: $composeFile"
    exit 2
  }
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $docker) {
    Write-Error 'docker not found in PATH'
    exit 1
  }
  Push-Location (Join-Path $RepoRoot 'deploy\agent')
  try {
    & docker compose -f docker-compose.agent.yml @ComposeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
}

function Start-AgentDockerService {
  param(
    [Parameter(Mandatory = $true)][string]$Profile,
    [int]$StartupWaitSec = 120,
    [switch]$SkipBuild
  )
  $root = Get-KuronekoRepoRootForDocker
  Ensure-AgentInstanceEnvFile $root $Profile
  $upArgs = @('--profile', $Profile, 'up', '-d')
  if (-not $SkipBuild) { $upArgs += '--build' }
  Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs $upArgs
  $deadline = (Get-Date).AddSeconds($StartupWaitSec)
  $container = switch ($Profile) {
    'kuroneko' { 'utlra-agent-kuroneko' }
    'shiro'    { 'utlra-agent-shiro' }
    'gin'      { 'utlra-agent-gin' }
    'aoi'      { 'utlra-agent-aoi' }
    'yuanbao'  { 'utlra-agent-yuanbao' }
    'bot1'     { 'utlra-agent-bot1' }
    'bot2'     { 'utlra-agent-bot2' }
    default    { $null }
  }
  while ((Get-Date) -lt $deadline) {
    if ($container) {
      $state = docker inspect -f '{{.State.Health.Status}}' $container 2>$null
      if ($state -eq 'healthy') { return }
    }
    Start-Sleep -Seconds 2
  }
  Write-Error "Agent docker profile '$Profile' did not become healthy within ${StartupWaitSec}s"
  exit 1
}

function Stop-AgentDockerService {
  param([Parameter(Mandatory = $true)][string]$Profile)
  $root = Get-KuronekoRepoRootForDocker
  Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @('--profile', $Profile, 'stop')
}

function Test-AgentDockerService {
  param([Parameter(Mandatory = $true)][string]$Profile)
  $container = switch ($Profile) {
    'kuroneko' { 'utlra-agent-kuroneko' }
    'shiro'    { 'utlra-agent-shiro' }
    'gin'      { 'utlra-agent-gin' }
    'aoi'      { 'utlra-agent-aoi' }
    'yuanbao'  { 'utlra-agent-yuanbao' }
    'bot1'     { 'utlra-agent-bot1' }
    'bot2'     { 'utlra-agent-bot2' }
    default    { return $false }
  }
  $running = docker inspect -f '{{.State.Running}}' $container 2>$null
  if ($running -ne 'true') { return $false }
  $health = docker inspect -f '{{.State.Health.Status}}' $container 2>$null
  if ($health -eq 'healthy') { return $true }
  return $false
}

function Start-AllAgentsDocker {
  param([int]$StartupWaitSec = 240)
  $root = Get-KuronekoRepoRootForDocker
  Ensure-AllAgentEnvFiles $root
  Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @('--profile', 'all', 'up', '-d', '--build')
  foreach ($p in @('kuroneko', 'shiro', 'gin', 'aoi')) {
    $ok = $false
    $deadline = (Get-Date).AddSeconds($StartupWaitSec)
    while ((Get-Date) -lt $deadline) {
      if (Test-AgentDockerService -Profile $p) { $ok = $true; break }
      Start-Sleep -Seconds 2
    }
    if (-not $ok) {
      Write-Error "Agent '$p' did not become healthy"
      exit 1
    }
  }
}

function Stop-AllAgentsDocker {
  $root = Get-KuronekoRepoRootForDocker
  Invoke-AgentDockerCompose -RepoRoot $root -ComposeArgs @('--profile', 'all', 'stop')
}
