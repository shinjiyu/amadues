param(
  [Parameter(Mandatory = $true)]
  [string]$Service
)

. "$PSScriptRoot\_services.ps1"
$svc = Get-KuronekoService $Service
if (Test-KuronekoHealth $svc) { exit 0 }
exit 1
