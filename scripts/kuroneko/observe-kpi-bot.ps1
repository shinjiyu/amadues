# Poll bot1/bot2 KPI + inner-brain state (Bot Lab E2E observer)
param(
  [ValidateSet('bot1', 'bot2')]
  [string]$Agent = 'bot1',
  [string]$KpiId = '',
  [int]$IntervalSec = 120,
  [int]$DurationMin = 0,
  [switch]$Once
)

$port = if ($Agent -eq 'bot2') { 8797 } else { 8796 }
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$dataRoot = Join-Path $root "packages\server\data-$Agent"
$logFile = Join-Path $root "scripts\local-dashboard\.logs\agent-$Agent-local.log"
$base = "http://127.0.0.1:$port"

function Get-Json($uri) {
  try {
    return Invoke-RestMethod -Uri $uri -TimeoutSec 8
  } catch {
    return $null
  }
}

function Show-Snapshot {
  param([string]$Label)
  Write-Host ""
  Write-Host "=== $Label @ $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor Cyan

  $health = Get-Json "$base/api/health"
  if (-not $health) {
    Write-Host "Agent not healthy on $base" -ForegroundColor Red
    return
  }
  Write-Host "health: ok"

  $kpis = Get-Json "$base/api/kpis?status=active"
  if ($kpis -and $kpis.kpis) {
    Write-Host "active KPIs: $($kpis.kpis.Count)"
    foreach ($k in $kpis.kpis) {
      $mark = if ($KpiId -and $k.kpiId -eq $KpiId) { ' <<<' } else { '' }
      Write-Host ("  - {0} idle={1} bursts={2}{3}" -f $k.kpiId, $k.consecutiveIdleBursts, $k.bursts.Count, $mark)
      Write-Host ("    {0}" -f ($k.description.Substring(0, [Math]::Min(100, $k.description.Length))))
    }
  } else {
    Write-Host "active KPIs: 0"
  }

  if ($KpiId) {
    $detail = Get-Json "$base/api/kpis/$KpiId"
    if ($detail) {
      Write-Host "KPI detail bursts:"
      foreach ($b in $detail.bursts) {
        Write-Host ("  - {0} status={1} kpiId={2} ticks={3} deliverables={4}" -f `
            $b.instanceId, $b.status, $b.kpiId, $b.ticks, $b.deliverableCount)
      }
    }
  }

  $brains = Get-Json "$base/api/inner-brains"
  if ($brains -and $brains.instances) {
    $live = @($brains.instances | Where-Object { $_.status -in @('RUNNING', 'AWAITING', 'BLOCKED') })
    Write-Host "live inner brains: $($live.Count)"
    foreach ($b in $live) {
      Write-Host ("  - {0} [{1}] kpi={2}" -f $b.instanceId, $b.status, $(if ($b.kpiId) { $b.kpiId } else { '-' }))
    }
  }

  $proof = Get-ChildItem -Path (Join-Path $dataRoot 'workspaces') -Filter 'kpi-e2e-proof.txt' -Recurse -ErrorAction SilentlyContinue
  if ($proof) {
    Write-Host "E2E proof file(s):" -ForegroundColor Green
    $proof | ForEach-Object { Write-Host "  $($_.FullName)" }
  }

  $stallIdx = Join-Path $dataRoot 'stall-alerts\index.jsonl'
  if (Test-Path $stallIdx) {
    $tail = Get-Content $stallIdx -Tail 3 -ErrorAction SilentlyContinue
    if ($tail) {
      Write-Host "stall-alerts (last 3):"
      $tail | ForEach-Object { Write-Host "  $_" }
    }
  }

  if (Test-Path $logFile) {
    $patterns = 'kpi_inner_goal|auto continue|skip kpi_inner_goal|burst done|casual_chat_defer|design.giveup|空转'
    $hits = Select-String -Path $logFile -Pattern $patterns -ErrorAction SilentlyContinue | Select-Object -Last 8
    if ($hits) {
      Write-Host "log tail (KPI/stall):"
      $hits | ForEach-Object { Write-Host "  $($_.Line.Trim())" }
    }
  } else {
    Write-Host "log not found: $logFile"
  }
}

if ($Once -or $DurationMin -le 0) {
  Show-Snapshot -Label $Agent
  exit 0
}

$end = (Get-Date).AddMinutes($DurationMin)
while ((Get-Date) -lt $end) {
  Show-Snapshot -Label $Agent
  Start-Sleep -Seconds $IntervalSec
}
