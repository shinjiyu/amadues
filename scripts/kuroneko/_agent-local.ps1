# 本地进程启动 Agent（同 deploy/agent/env/<name>.env + 同 DATA_ROOT，跑仓库 tsx 源码）

. "$PSScriptRoot\_agent-docker.ps1"

function Import-AgentEnvFile([string]$EnvPath) {
  if (-not (Test-Path $EnvPath)) {
    Write-Error "Missing env file: $EnvPath"
    exit 1
  }
  foreach ($raw in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $line.Substring(0, $eq).Trim()
    if ($name -notmatch '^[A-Z_][A-Z0-9_]*$') { continue }
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2) {
      $q = $value[0]
      if (($q -eq '"' -and $value[-1] -eq '"') -or ($q -eq "'" -and $value[-1] -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    Set-Item -Path "Env:$name" -Value $value
  }
}

function Get-AgentLocalPidFile([string]$Name) {
  Join-Path $PSScriptRoot "..\local-dashboard\.pids\agent-$Name-local.pid"
}

function Stop-AgentLocalProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$Port
  )
  $pidFile = Get-AgentLocalPidFile $Name
  if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
      try { & taskkill.exe /F /T /PID $oldPid 2>&1 | Out-Null } catch { }
      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    if (-not $c.OwningProcess) { continue }
    try { & taskkill.exe /F /T /PID $c.OwningProcess 2>&1 | Out-Null } catch { }
  }
  Start-Sleep -Milliseconds 400
}

function Start-AgentLocalProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$DataDirRel,
    [string]$RepoRoot,
    [string]$EnvRepoRoot,
    [switch]$Watch
  )
  $root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Get-KuronekoRepoRootForDocker }
  $envRoot = if ($EnvRepoRoot) { (Resolve-Path $EnvRepoRoot).Path } else { $root }
  Ensure-AgentInstanceEnvFile $envRoot $Name

  $container = switch ($Name) {
    'kuroneko' { 'utlra-agent-kuroneko' }
    'shiro'    { 'utlra-agent-shiro' }
    'gin'      { 'utlra-agent-gin' }
    'aoi'      { 'utlra-agent-aoi' }
    'yuanbao'  { 'utlra-agent-yuanbao' }
    'bot1'     { 'utlra-agent-bot1' }
    'bot2'     { 'utlra-agent-bot2' }
    'bot3'     { 'utlra-agent-bot3' }
    default    { $null }
  }
  if ($container) {
    try { & docker stop $container 2>&1 | Out-Null } catch { }
  }

  Stop-AgentLocalProcess -Name $Name -Port $Port

  $envPath = Join-Path (Get-AgentEnvDir $envRoot) "$Name.env"
  Import-AgentEnvFile $envPath

  $dataRootPath = Join-Path $root $DataDirRel
  if (-not (Test-Path $dataRootPath)) {
    New-Item -ItemType Directory -Force -Path $dataRootPath | Out-Null
  }
  $dataRoot = (Resolve-Path $dataRootPath).Path
  $env:UTLRA_DATA_ROOT = $dataRoot
  $env:PORT = [string]$Port

  $npmScript = if ($Watch) { 'dev' } else { 'dev:nowatch' }
  $logDir = Join-Path $root 'scripts\local-dashboard\.logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logFile = Join-Path $logDir "agent-$Name-local.log"
  Set-Content -Path $logFile -Value "[$((Get-Date).ToString('o'))] start agent-$Name-local PORT=$Port DATA_ROOT=$dataRoot npm=$npmScript" -Encoding utf8

  $argLine = "npm run $npmScript -w @utlra/server 1>> `"$logFile`" 2>&1"
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $argLine) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  if (-not $p) { exit 1 }
  $p.Id | Set-Content -Path (Get-AgentLocalPidFile $Name) -Encoding ascii

  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) {
        Write-Host "Agent $Name local ready: http://127.0.0.1:$Port  DATA_ROOT=$dataRoot"
        Write-Host "Log: $logFile"
        return
      }
    } catch { }
    Start-Sleep -Seconds 2
  }
  Write-Error "Agent $Name local did not become healthy within 120s. See $logFile"
  exit 1
}
