# Structurizr vNext via Docker (no local Java required)
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$StructurizrArgs
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$mount = $here -replace '\\', '/'

if ($StructurizrArgs.Count -eq 0) {
    $StructurizrArgs = @("help")
}

if ($StructurizrArgs.Count -eq 1 -and $StructurizrArgs[0] -eq "local") {
    docker run --rm -p 8080:8080 `
        -v "${mount}:/usr/local/structurizr" `
        structurizr/structurizr local /usr/local/structurizr
} else {
    docker run --rm `
        -v "${mount}:/usr/local/structurizr" `
        -w /usr/local/structurizr `
        structurizr/structurizr `
        @StructurizrArgs
}
