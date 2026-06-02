param()
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8797/api/health' -UseBasicParsing -TimeoutSec 8
  if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { exit 0 }
} catch { }
exit 1
