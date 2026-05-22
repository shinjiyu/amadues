# Structurizr vNext via local .war (when Docker Hub is unreachable)
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$StructurizrArgs
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$war = Join-Path $here ".tools\structurizr.war"

if (-not (Test-Path $war)) {
    Write-Host "Missing $war — download with:"
    Write-Host "  curl.exe -L -o `"$war`" https://download.structurizr.com/structurizr.war"
    exit 1
}

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

if ($StructurizrArgs.Count -eq 0) {
    $StructurizrArgs = @("help")
}
# local 必须带数据目录，否则只会看到 Structurizr 内置示例工作区
if ($StructurizrArgs.Count -eq 1 -and $StructurizrArgs[0] -eq "local") {
    $StructurizrArgs += $here
}

Push-Location $here
try {
    java -jar $war @StructurizrArgs
} finally {
    Pop-Location
}
