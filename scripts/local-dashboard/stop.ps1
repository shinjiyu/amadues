param(
  [Parameter(Mandatory = $true)]
  [string]$Service
)

. "$PSScriptRoot\_services.ps1"
$svc = Get-KuronekoService $Service
$pidFile = Get-KuronekoPidFile $Service

if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($procId) {
    & taskkill.exe /F /T /PID $procId 2>$null | Out-Null
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Stop-KuronekoServicePorts $svc
exit 0
