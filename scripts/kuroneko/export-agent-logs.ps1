param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('kuroneko', 'shiro', 'gin', 'aoi')]
  [string]$Agent,

  [string]$OutRoot = ''
)

. "$PSScriptRoot\_agent-docker.ps1"

$map = @{
  kuroneko = @{ container = 'utlra-agent-kuroneko'; data = 'data'; port = 8787 }
  shiro    = @{ container = 'utlra-agent-shiro'; data = 'data-shiro'; port = 8788 }
  gin      = @{ container = 'utlra-agent-gin'; data = 'data-gin'; port = 8789 }
  aoi      = @{ container = 'utlra-agent-aoi'; data = 'data-aoi'; port = 8791 }
}

$root = Get-KuronekoRepoRootForDocker
$info = $map[$Agent]
$src = Join-Path $root "packages\server\$($info.data)"
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = if ($OutRoot) { Join-Path $OutRoot "$Agent-log-dump-$ts" } else { Join-Path $root "exports\$Agent-log-dump-$ts" }

New-Item -ItemType Directory -Path $out -Force | Out-Null
New-Item -ItemType Directory -Path "$out\data" -Force | Out-Null

docker logs --timestamps $info.container 2>&1 | Out-File -FilePath "$out\docker-$($info.container).log" -Encoding utf8

$files = Get-ChildItem $src -Recurse -Include *.log, *.jsonl -File -ErrorAction SilentlyContinue
$copied = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($src.Length).TrimStart('\')
  $dest = Join-Path "$out\data" $rel
  $destDir = Split-Path $dest -Parent
  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  Copy-Item $f.FullName $dest -Force
  $copied++
}

$context = @(
  'inner-brain-registry.json',
  'autonomy\policy.json',
  'autonomy\task-state.json',
  'identities.json',
  'chat\threads.json',
  'kpi-registry.json'
)
New-Item -ItemType Directory -Path "$out\context" -Force | Out-Null
foreach ($c in $context) {
  $p = Join-Path $src $c
  if (Test-Path $p) {
    $d = Join-Path "$out\context" $c
    $dd = Split-Path $d -Parent
    if (-not (Test-Path $dd)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }
    Copy-Item $p $d -Force
  }
}

$manifest = [ordered]@{
  exportedAt = (Get-Date).ToString('o')
  agent = $Agent
  container = $info.container
  port = $info.port
  dataRoot = $src
  dockerLogLines = (Get-Content "$out\docker-$($info.container).log" | Measure-Object -Line).Lines
  dataLogFiles = $copied
  totalBytes = (Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
}
$manifest | ConvertTo-Json -Depth 3 | Out-File "$out\manifest.json" -Encoding utf8

Write-Host "Exported to: $out"
Write-Host "  docker log lines: $($manifest.dockerLogLines)"
Write-Host "  data log/jsonl:   $copied files"
Write-Host "  total:            $([math]::Round($manifest.totalBytes / 1MB, 2)) MB"
