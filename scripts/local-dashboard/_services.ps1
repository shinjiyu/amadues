# Kuroneko 服务表 — 与 apps/ops-console/service-registry.ts 对齐
$script:KuronekoRepoRoot = if ($env:KURONEKO_ROOT) { $env:KURONEKO_ROOT } else { 'D:\kuroneko' }
$script:KuronekoPidDir = Join-Path $KuronekoRepoRoot 'scripts\local-dashboard\.pids'

$script:KuronekoServices = @{
  'agent-kuroneko' = @{
    Label          = 'Agent: Kuroneko'
    NpmScript      = 'dev:server'
    Port           = 8787
    HealthUrl      = 'http://127.0.0.1:8787/api/health'
    OpenUrl        = $null
    StartupWaitSec = 120
  }
  'agent-shiro' = @{
    Label          = 'Agent: Shiro'
    NpmScript      = 'dev:agent2'
    Port           = 8788
    HealthUrl      = 'http://127.0.0.1:8788/api/health'
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
  'chat-server' = @{
    Label          = 'Chat Server'
    NpmScript      = 'dev:chat-server'
    Port           = 8790
    HealthUrl      = 'http://127.0.0.1:8790/healthz'
    OpenUrl        = $null
    StartupWaitSec = 90
  }
  'web-chat' = @{
    Label          = 'Web Chat H5'
    NpmScript      = 'dev:web-chat'
    Port           = 5180
    ExtraPorts     = @(5181)
    HealthUrl      = $null
    OpenUrl        = 'http://127.0.0.1:5180/'
    StartupWaitSec = 120
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
