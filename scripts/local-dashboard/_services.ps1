# Kuroneko 服务表 — 与 apps/ops-console/service-registry.ts 对齐
$script:KuronekoRepoRoot = if ($env:KURONEKO_ROOT) { $env:KURONEKO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$script:KuronekoPidDir = Join-Path $KuronekoRepoRoot 'scripts\local-dashboard\.pids'

$script:KuronekoServices = @{
  'agent-kuroneko' = @{
    Label          = 'Agent: Kuroneko (Docker)'
    DockerProfile  = 'kuroneko'
    ContainerName  = 'utlra-agent-kuroneko'
    Port           = 8787
    HealthUrl      = 'http://127.0.0.1:8787/api/health'
    OpenUrl        = $null
    StartupWaitSec = 180
  }
  'agent-shiro' = @{
    Label          = 'Agent: Shiro (Docker)'
    DockerProfile  = 'shiro'
    ContainerName  = 'utlra-agent-shiro'
    Port           = 8788
    HealthUrl      = 'http://127.0.0.1:8788/api/health'
    OpenUrl        = $null
    StartupWaitSec = 180
  }
  'agent-gin' = @{
    Label          = 'Agent: Gin (Docker)'
    DockerProfile  = 'gin'
    ContainerName  = 'utlra-agent-gin'
    Port           = 8789
    HealthUrl      = 'http://127.0.0.1:8789/api/health'
    OpenUrl        = $null
    StartupWaitSec = 180
  }
  'agent-aoi' = @{
    Label          = 'Agent: Aoi (Docker)'
    DockerProfile  = 'aoi'
    ContainerName  = 'utlra-agent-aoi'
    Port           = 8791
    HealthUrl      = 'http://127.0.0.1:8791/api/health'
    OpenUrl        = $null
    StartupWaitSec = 180
  }
  'agent-yuanbao' = @{
    Label          = 'Agent: 元宝 / webchat-lab (Docker)'
    DockerProfile  = 'yuanbao'
    ContainerName  = 'utlra-agent-yuanbao'
    Port           = 8793
    HealthUrl      = 'http://127.0.0.1:8793/api/health'
    OpenUrl        = $null
    StartupWaitSec = 180
  }
  'agent-bot1' = @{
    Label          = 'Agent: Bot1 / GLM Coding / webchat-lab (Local)'
    LocalAgent     = @{ Name = 'bot1'; Port = 8796; DataDirRel = 'packages\server\data-bot1' }
    Port           = 8796
    HealthUrl      = 'http://127.0.0.1:8796/api/health'
    OpenUrl        = $null
    StartupWaitSec = 120
  }
  'agent-bot2' = @{
    Label          = 'Agent: Bot2 / GLM-5.1-FP8 / webchat-lab (Local)'
    LocalAgent     = @{ Name = 'bot2'; Port = 8797; DataDirRel = 'packages\server\data-bot2' }
    Port           = 8797
    HealthUrl      = 'http://127.0.0.1:8797/api/health'
    OpenUrl        = $null
    StartupWaitSec = 120
  }
  'dashboard' = @{
    Label          = 'Dashboard'
    NpmScript      = 'dev:dashboard'
    Port           = 5173
    HealthUrl      = $null
    OpenUrl        = 'http://127.0.0.1:5173/'
    StartupWaitSec = 60
  }
  'drive9-explorer' = @{
    Label            = 'Drive9 Explorer'
    NpmScript        = 'dev:drive9'
    Port             = 7782
    ExtraPorts       = @(7780)
    # 只探 HTTP 200：Drive9 未配置时 /api/status 仍返回 200（ok:false），UI 可提示配置
    HealthUrl        = 'http://127.0.0.1:7782/'
    ExtraHealthUrls  = @('http://127.0.0.1:7780/api/status')
    OpenUrl          = 'http://127.0.0.1:7782/'
    StartupWaitSec   = 90
  }
  'ops-console' = @{
    Label            = 'Ops Console'
    NpmScript        = 'dev:ops'
    Port             = 7779
    ExtraPorts       = @(7777)
    HealthUrl        = 'http://127.0.0.1:7779/'
    ExtraHealthUrls  = @('http://127.0.0.1:7777/api/services')
    OpenUrl          = 'http://127.0.0.1:7779/'
    StartupWaitSec   = 90
  }
}

function Get-KuronekoService([string]$ServiceId) {
  if (-not $script:KuronekoServices.ContainsKey($ServiceId)) {
    Write-Error "Unknown service: $ServiceId"
    exit 2
  }
  $script:KuronekoServices[$ServiceId]
}

function Get-KuronekoPidFile([string]$ServiceId) {
  if (-not (Test-Path $script:KuronekoPidDir)) {
    New-Item -ItemType Directory -Path $script:KuronekoPidDir -Force | Out-Null
  }
  Join-Path $script:KuronekoPidDir "$ServiceId.pid"
}

function Stop-KuronekoPort([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    if (-not $c.OwningProcess) { continue }
    & taskkill.exe /F /T /PID $c.OwningProcess 2>$null | Out-Null
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}

function Stop-KuronekoServicePorts([hashtable]$Svc) {
  if ($Svc.Port) { Stop-KuronekoPort $Svc.Port }
  if ($Svc.ExtraPorts) {
    foreach ($p in $Svc.ExtraPorts) { Stop-KuronekoPort $p }
  }
}

function Test-KuronekoHealth([hashtable]$Svc) {
  $probeUrls = @()
  if ($Svc.HealthUrl) { $probeUrls += $Svc.HealthUrl }
  if ($Svc.ExtraHealthUrls) { $probeUrls += $Svc.ExtraHealthUrls }
  if ($probeUrls.Count -gt 0) {
    foreach ($url in $probeUrls) {
      try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
        if (-not ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)) { return $false }
        if ($Svc.HealthJsonField -and $url -eq $Svc.HealthUrl) {
          $body = $r.Content | ConvertFrom-Json
          $field = $Svc.HealthJsonField
          if (-not $body.$field) { return $false }
        }
      } catch {
        return $false
      }
    }
    return $true
  }
  if ($Svc.OpenUrl) {
    try {
      $r = Invoke-WebRequest -Uri $Svc.OpenUrl -UseBasicParsing -TimeoutSec 8
      return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
    } catch {
      return $false
    }
  }
  if ($Svc.Port) {
    return (Test-NetConnection -ComputerName 127.0.0.1 -Port $Svc.Port -WarningAction SilentlyContinue).TcpTestSucceeded
  }
  return $false
}

function Wait-KuronekoHealthy([hashtable]$Svc) {
  $waitSec = if ($Svc.StartupWaitSec) { [int]$Svc.StartupWaitSec } else { 90 }
  $deadline = (Get-Date).AddSeconds($waitSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-KuronekoHealth $Svc) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
