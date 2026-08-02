param([switch]$Execute)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $repoRoot

node .\scripts\verify-order-sync-watchdog-gate.js
if ($LASTEXITCODE -ne 0) { throw "QP_WATCHDOG_DEPLOY_BLOCKED: source gate failed" }
if (-not $Execute) {
    Write-Output "QP_WATCHDOG_DEPLOY_STATUS=DRY_RUN"
    Write-Output "QP_WATCHDOG_DEPLOY_SCOPE=functions:orderSyncWatchdog"
    exit 0
}
if ($env:QP_ORDER_SYNC_WATCHDOG_DEPLOY_APPROVED -ne "YES") {
    throw "QP_WATCHDOG_DEPLOY_BLOCKED: explicit deploy approval environment marker is missing"
}
firebase deploy --project quickpilot-39d72 --config firebase.order-sync-watchdog-only.json --only functions:orderSyncWatchdog
if ($LASTEXITCODE -ne 0) { throw "QP_WATCHDOG_DEPLOY_BLOCKED: isolated deploy failed" }
Write-Output "QP_WATCHDOG_DEPLOY_STATUS=DEPLOYED"
