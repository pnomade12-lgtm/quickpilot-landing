param(
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Assert-QpActionPermit.ps1")

$Project = "quickpilot-39d72"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Config = Join-Path $Root "firebase.order-sync-rules-only.json"

Push-Location $Root
try {
    & node ".\scripts\build-order-sync-rules-candidate.js"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not reproduce the exact rules candidate."
    }
    & node ".\scripts\verify-order-sync-rules-candidate.js" "--live-compatible-candidate"
    if ($LASTEXITCODE -ne 0) {
        throw "Live rules are not the compatible protected candidate."
    }

    $configJson = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 |
        ConvertFrom-Json
    $configKeys = @($configJson.PSObject.Properties.Name)
    if ($configKeys -contains "functions" -or
        $configKeys -contains "hosting" -or
        $configKeys -contains "storage" -or
        $configJson.database.rules -ne "rules/database.rules.order-sync-candidate.json") {
        throw "Rules deployment config is not isolated."
    }

    if (-not $Execute) {
        Write-Output "QP_ORDER_SYNC_RULES_DEPLOY=DRY_RUN"
        Write-Output "No Firebase resource or control value was changed."
        Write-Output "Approved command: firebase deploy --config firebase.order-sync-rules-only.json --only database --project quickpilot-39d72"
        exit 0
    }

    if ($env:QP_ORDER_SYNC_RULES_DEPLOY_APPROVED -ne "YES") {
        throw "Execute requires QP_ORDER_SYNC_RULES_DEPLOY_APPROVED=YES."
    }

    Assert-QpActionPermit -Action "RULES_DEPLOY"
    & firebase deploy --config $Config --only "database" --project $Project
    if ($LASTEXITCODE -ne 0) {
        throw "Isolated order sync rules deployment failed."
    }

    & node ".\scripts\verify-order-sync-rules-candidate.js" "--live-candidate"
    if ($LASTEXITCODE -ne 0) {
        throw "Live rules do not match the exact candidate after deployment."
    }
    Write-Output "QP_ORDER_SYNC_RULES_DEPLOY=PASS"
    Write-Output "Control remains missing/BLOCKED until a separate explicit publish step."
}
finally {
    Pop-Location
}
