param(
    [Parameter(Mandatory = $true)]
    [string]$Config,
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Assert-QpActionPermit.ps1")

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = [IO.Path]::GetFullPath((Join-Path $root $Config))
$rootPrefix = $root.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
if (-not $configPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "QP_HOSTING_DEPLOY_BLOCKED: config must be an exact file inside quickpilot-landing"
}
$configJson = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$keys = @($configJson.PSObject.Properties.Name)
if ($keys -notcontains "hosting" -or
    @($keys | Where-Object { $_ -in @("functions", "database", "firestore", "storage", "extensions") }).Count -gt 0) {
    throw "QP_HOSTING_DEPLOY_BLOCKED: config is not Hosting-only"
}
if (-not $Execute) {
    Write-Output "QP_HOSTING_DEPLOY_STATUS=DRY_RUN"
    Write-Output "QP_HOSTING_DEPLOY_CONFIG=$configPath"
    Write-Output "No Hosting or Firebase resource was changed."
    exit 0
}
if ($env:QP_HOSTING_DEPLOY_APPROVED -ne "YES") {
    throw "QP_HOSTING_DEPLOY_BLOCKED: Execute requires QP_HOSTING_DEPLOY_APPROVED=YES"
}

Assert-QpActionPermit -Action "HOSTING_DEPLOY"
& firebase deploy --config $configPath --only "hosting" --project "quickpilot-39d72"
if ($LASTEXITCODE -ne 0) {
    throw "QP_HOSTING_DEPLOY_BLOCKED: isolated Hosting deploy failed"
}
Write-Output "QP_HOSTING_DEPLOY_STATUS=DEPLOYED"
