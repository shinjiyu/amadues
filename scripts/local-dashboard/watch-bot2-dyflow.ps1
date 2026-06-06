# Tail bot2 inner-brain pi-mono logs, surfacing DyFlow lifecycle events.
$root = 'D:\kuroneko\packages\server\data-bot2\workspaces'
$files = @(
  "$root\task-ib-mq1vvq2p-3165\.run\pi-mono\logs\2026-06-06.jsonl",
  "$root\task-ib-mq20jgwv-d518\.run\pi-mono\logs\2026-06-06.jsonl"
)
$pos = @{}
foreach ($f in $files) { if (Test-Path $f) { $pos[$f] = (Get-Item $f).Length } else { $pos[$f] = 0 } }
Write-Output "watch started $(Get-Date -Format o)"
while ($true) {
  Start-Sleep -Seconds 15
  foreach ($f in $files) {
    if (-not (Test-Path $f)) { continue }
    $len = (Get-Item $f).Length
    if ($len -le $pos[$f]) { continue }
    $fs = [System.IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
    $fs.Seek($pos[$f], 'Begin') | Out-Null
    $sr = New-Object System.IO.StreamReader($fs)
    $new = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
    $pos[$f] = $len
    $tag = if ($f -match '3165') { '3165' } else { 'd518' }
    foreach ($line in ($new -split "`n")) {
      if (-not $line.Trim()) { continue }
      try { $o = $line | ConvertFrom-Json } catch { continue }
      $m = $o.module; $e = $o.event
      if ($m -in @('designer','dyflow-controller','runner','node-assembler','node-abstractor') -or $e -in @('done','failed')) {
        $d = $o.data
        $extra = "$($d.mode)$($d.nodeInstId)$($d.localId)$($d.defId)"
        if ($null -ne $d.nodes) { $extra = "$extra nodes=$($d.nodes)" }
        Write-Output "[$tag] $($o.ts) $m/$e $extra"
      }
    }
  }
}
