param(
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Project = "quickpilot-39d72"
$ExpectedLiveHash = "cf88a416502890b58ff33399fe04137108cd79c7"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Config = Join-Path $Root "firebase.order-live-only.json"
$ReleaseDir = Join-Path $Root "functions-order-live-release"

Push-Location $Root
try {
    & node ".\scripts\verify-order-live-cost-gate.js"
    if ($LASTEXITCODE -ne 0) {
        throw "QP orderLive cost gate failed."
    }

    $releaseFiles = @(
        Get-ChildItem -LiteralPath $ReleaseDir -Recurse -File |
            Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
            ForEach-Object {
                $_.FullName.Substring($ReleaseDir.Length + 1).Replace("\", "/")
            } |
            Sort-Object
    )
    $expectedFiles = @(
        "index.js",
        "order-live-guard.js",
        "package-lock.json",
        "package.json",
        "test/order-live-guard.test.js"
    ) | Sort-Object
    if (($releaseFiles -join "`n") -ne ($expectedFiles -join "`n")) {
        throw "Isolated release directory contains unexpected files."
    }

    $hashLines = Get-ChildItem -LiteralPath $ReleaseDir -Recurse -File |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($ReleaseDir.Length + 1).Replace("\", "/")
            $sha = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            "$relative=$sha"
        }
    Write-Output "QP_ORDER_LIVE_RELEASE_FILES=$($hashLines.Count)"
    $hashLines | ForEach-Object { Write-Output $_ }

    if (-not $Execute) {
        Write-Output "QP_ORDER_LIVE_DEPLOY=DRY_RUN"
        Write-Output "No Firebase resource was changed."
        Write-Output "Approved command: firebase deploy --config firebase.order-live-only.json --only functions:orderLive --project quickpilot-39d72"
        exit 0
    }

    if ($env:QP_ORDER_LIVE_DEPLOY_APPROVED -ne "YES") {
        throw "Execute requires QP_ORDER_LIVE_DEPLOY_APPROVED=YES."
    }

    $liveRulesText = (& firebase database:get "/.settings/rules" --project $Project) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read live RTDB rules."
    }
    $liveRules = $liveRulesText | ConvertFrom-Json
    $ordersWrite = $liveRules.rules.v1.users.'$uid'.orders.'.write'
    if ($ordersWrite -ne $false) {
        throw "Fail closed: live orders/.write must be false before function deployment."
    }

    $beforeText = (& firebase functions:list --project $Project --json) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect live functions before deployment."
    }
    $before = $beforeText | ConvertFrom-Json
    $beforeOrderLive = @($before.result | Where-Object { $_.id -eq "orderLive" })
    if ($beforeOrderLive.Count -ne 1) {
        throw "Expected exactly one live orderLive function."
    }
    if ($beforeOrderLive[0].hash -ne $ExpectedLiveHash) {
        throw "Live orderLive hash drifted. Expected $ExpectedLiveHash, got $($beforeOrderLive[0].hash)."
    }
    if ($beforeOrderLive[0].region -ne "asia-southeast1" -or
        $beforeOrderLive[0].runtime -ne "nodejs20" -or
        $beforeOrderLive[0].eventTrigger.eventType -ne "providers/google.firebase.database/eventTypes/ref.write" -or
        $beforeOrderLive[0].eventTrigger.eventFilters.resource -ne "projects/_/instances/quickpilot-39d72-default-rtdb/refs/v1/users/{uid}/orders/{date}/{orderId}") {
        throw "Live orderLive trigger identity is not the approved baseline."
    }

    $beforeHashes = @{}
    foreach ($fn in $before.result) {
        if ($fn.id -ne "orderLive") {
            $beforeHashes[$fn.id] = $fn.hash
        }
    }

    & firebase deploy --config $Config --only "functions:orderLive" --project $Project
    if ($LASTEXITCODE -ne 0) {
        throw "Isolated orderLive deployment failed."
    }

    $afterText = (& firebase functions:list --project $Project --json) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect live functions after deployment."
    }
    $after = $afterText | ConvertFrom-Json
    foreach ($fn in $after.result) {
        if ($fn.id -ne "orderLive" -and
            $beforeHashes.ContainsKey($fn.id) -and
            $beforeHashes[$fn.id] -ne $fn.hash) {
            throw "Unapproved function changed: $($fn.id)"
        }
    }
    $afterOrderLive = @($after.result | Where-Object { $_.id -eq "orderLive" })
    if ($afterOrderLive.Count -ne 1 -or
        $afterOrderLive[0].state -ne "ACTIVE" -or
        $afterOrderLive[0].runtime -ne "nodejs20" -or
        $afterOrderLive[0].region -ne "asia-southeast1" -or
        [int]$afterOrderLive[0].timeoutSeconds -ne 30 -or
        [int]$afterOrderLive[0].maxInstances -ne 10) {
        throw "Deployed orderLive metadata does not match the approved release."
    }

    Write-Output "QP_ORDER_LIVE_DEPLOY=PASS"
    Write-Output "Only functions:orderLive changed; live orders write block remained closed."
}
finally {
    Pop-Location
}
