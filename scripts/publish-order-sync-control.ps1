param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("BLOCKED", "CANARY", "VERSION")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [long]$Generation,

    [Parameter(Mandatory = $true)]
    [ValidateLength(8, 120)]
    [string]$EvidenceId,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [long]$MinimumClientVersionCode,

    [string]$AllowedUid = "",
    [string]$AllowedDate = "",
    [string]$CanaryStampPath = "",
    [string]$ClientRepoPath = "",

    [switch]$Execute
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Project = "quickpilot-39d72"
$Instance = "quickpilot-39d72-default-rtdb"
$Target = "/v1/app/order_sync_control"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Public = Join-Path $Root "public"
$Firebase = Get-Command firebase.cmd -ErrorAction Stop
$Enabled = $Mode -ne "BLOCKED"
$HashPattern = "^[0-9a-f]{64}$"

function Fail([string]$Message) {
    throw "QP_ORDER_SYNC_CONTROL_BLOCKED: $Message"
}

function Read-FirebaseJson([string]$Path, [string]$Description) {
    $text = (& $Firebase.Source database:get $Path --project $Project --instance $Instance) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($text)) {
        Fail "could not read $Description"
    }
    if ($text.Trim() -eq "null") {
        return $null
    }
    try {
        return $text | ConvertFrom-Json
    } catch {
        Fail "$Description is not valid JSON"
    }
}

function Get-KstDate {
    $kst = [TimeZoneInfo]::FindSystemTimeZoneById("Korea Standard Time")
    return [TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow, $kst).ToString("yyyy-MM-dd")
}

function Require-Hash([object]$Value, [string]$Description) {
    $hash = "$Value".Trim().ToLowerInvariant()
    if ($hash -notmatch $HashPattern) {
        Fail "$Description must be an exact SHA-256"
    }
    return $hash
}

function Read-ProtectedRelease {
    $manifestPath = Join-Path $Public "qp-update.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Fail "public qp-update.json is missing"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedApks = @{
        beta = "qp-beta.apk"
        gwanje = "qp-gwanje.apk"
    }
    $release = [ordered]@{}
    foreach ($channel in @("beta", "gwanje")) {
        $entry = $manifest.$channel
        if ($null -eq $entry -or
            [long]$entry.versionCode -ne $MinimumClientVersionCode -or
            [string]::IsNullOrWhiteSpace("$($entry.versionName)") -or
            "$($entry.apk)" -ne $expectedApks[$channel]) {
            Fail "$channel public manifest does not match minimum client version $MinimumClientVersionCode"
        }
        $expectedHash = Require-Hash $entry.sha256 "$channel manifest hash"
        $apkPath = Join-Path $Public $expectedApks[$channel]
        if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
            Fail "$channel public APK is missing"
        }
        $localHash = (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($localHash -ne $expectedHash) {
            Fail "$channel public APK hash differs from qp-update.json"
        }
        $release[$channel] = [pscustomobject]@{
            versionName = "$($entry.versionName)"
            apk = $expectedApks[$channel]
            sha256 = $expectedHash
        }
    }

    $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $remoteManifestResponse = Invoke-WebRequest `
        -Uri "https://quickpilot-39d72.web.app/qp-update.json?control_check=$cacheBuster" `
        -UseBasicParsing
    $remoteManifestText = [System.Text.Encoding]::UTF8.GetString(
        $remoteManifestResponse.RawContentStream.ToArray()
    )
    $remoteManifest = $remoteManifestText | ConvertFrom-Json
    foreach ($channel in @("beta", "gwanje")) {
        $local = $release[$channel]
        $remote = $remoteManifest.$channel
        if ($null -eq $remote -or
            [long]$remote.versionCode -ne $MinimumClientVersionCode -or
            "$($remote.versionName)" -cne $local.versionName -or
            "$($remote.apk)" -ne $local.apk -or
            (Require-Hash $remote.sha256 "$channel remote manifest hash") -ne $local.sha256) {
            Fail "$channel remote manifest differs from the protected local release"
        }

        $tempApk = Join-Path ([System.IO.Path]::GetTempPath()) (
            "qp-control-{0}-{1}.apk" -f $channel, [guid]::NewGuid().ToString("N")
        )
        try {
            Invoke-WebRequest `
                -Uri "https://quickpilot-39d72.web.app/$($local.apk)?control_check=$cacheBuster" `
                -OutFile $tempApk `
                -UseBasicParsing
            $remoteHash = (Get-FileHash -LiteralPath $tempApk -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($remoteHash -ne $local.sha256) {
                Fail "$channel remote APK hash differs from the protected manifest"
            }
        } finally {
            if (Test-Path -LiteralPath $tempApk) {
                Remove-Item -LiteralPath $tempApk -Force
            }
        }
    }
    return [pscustomobject]$release
}

function Verify-InstalledCanary([object]$Release) {
    $today = Get-KstDate
    if ($AllowedDate -ne $today) {
        Fail "CANARY date must be the current KST date $today"
    }
    $installedVersion = Read-FirebaseJson `
        "/v1/users/$AllowedUid/app_version" `
        "canary app version"
    $allowedVersions = @($Release.beta.versionName, $Release.gwanje.versionName)
    if ("$installedVersion" -notin $allowedVersions) {
        Fail "CANARY UID has not reported the protected beta/gwanje version"
    }
    $versionProof = Read-FirebaseJson `
        "/v1/app/monitor_input/$AllowedUid/version" `
        "canary version monitor proof"
    if ($null -eq $versionProof -or
        "$($versionProof.value)" -cne "$installedVersion" -or
        [long]$versionProof.updatedAt -lt [DateTimeOffset]::UtcNow.AddHours(-24).ToUnixTimeMilliseconds() -or
        [long]$versionProof.updatedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeMilliseconds()) {
        Fail "CANARY UID version proof is missing, stale, or inconsistent"
    }
}

function Verify-CanaryPass([object]$Current, [object]$Release) {
    if ([string]::IsNullOrWhiteSpace($CanaryStampPath) -or
        -not (Test-Path -LiteralPath $CanaryStampPath -PathType Leaf)) {
        Fail "VERSION requires the measured CAN-F01 stamp"
    }
    $resolvedClientRepoPath = "$ClientRepoPath".Trim()
    if ([string]::IsNullOrWhiteSpace($resolvedClientRepoPath)) {
        $resolvedClientRepoPath = Join-Path (Split-Path -Parent $Root) "QuickPilot_beta"
    }
    $verifier = Join-Path $resolvedClientRepoPath "scripts\verify-qp-live-cost-canary.ps1"
    if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
        Fail "CAN-F01 verifier is missing"
    }
    $output = @(
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifier -StampPath $CanaryStampPath
    )
    if ($LASTEXITCODE -ne 0 -or
        "QP_LIVE_COST_CANARY_STATUS=PASS" -notin @($output | ForEach-Object { "$_".Trim() })) {
        Fail "CAN-F01 stamp did not pass the executable verifier"
    }
    $stamp = Get-Content -LiteralPath $CanaryStampPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([long]$stamp.version_code -ne $MinimumClientVersionCode -or
        "$($stamp.canary_uid)" -ne "$($Current.allowed_uid)" -or
        "$($stamp.canary_date)" -ne "$($Current.allowed_date)" -or
        (Require-Hash $stamp.artifact_hashes.beta_apk_sha256 "CAN-F01 beta APK hash") -ne $Release.beta.sha256 -or
        (Require-Hash $stamp.artifact_hashes.gwanje_apk_sha256 "CAN-F01 gwanje APK hash") -ne $Release.gwanje.sha256) {
        Fail "CAN-F01 stamp does not match the live CANARY and protected APK pair"
    }
}

if ($Mode -eq "BLOCKED" -and
    (-not [string]::IsNullOrEmpty($AllowedUid) -or
     -not [string]::IsNullOrEmpty($AllowedDate))) {
    Fail "BLOCKED control must not carry an allowed UID/date"
}
if ($Mode -eq "CANARY") {
    if ($AllowedUid -notmatch "^[A-Za-z0-9_-]{20,128}$" -or
        $AllowedDate -notmatch "^\d{4}-\d{2}-\d{2}$") {
        Fail "CANARY requires exact AllowedUid and YYYY-MM-DD AllowedDate"
    }
}
if ($Mode -eq "VERSION" -and
    (-not [string]::IsNullOrEmpty($AllowedUid) -or
     -not [string]::IsNullOrEmpty($AllowedDate))) {
    Fail "VERSION control must not carry a canary UID/date"
}
if ($Mode -eq "VERSION" -and $MinimumClientVersionCode -le 459) {
    Fail "VERSION is forbidden through vc459 because it can release historical permission-blocked outbox rows"
}

$Current = Read-FirebaseJson $Target "current order_sync_control"
if ($null -eq $Current) {
    if ($Mode -ne "BLOCKED") {
        Fail "missing live control can only be restored to BLOCKED"
    }
} else {
    if ($Generation -le [long]$Current.generation) {
        Fail "generation must strictly increase from the current control"
    }
    if ($EvidenceId -eq [string]$Current.evidence_id) {
        Fail "EvidenceId must change with each control generation"
    }
}

$Release = $null
if ($Mode -ne "BLOCKED") {
    & node ".\scripts\verify-order-sync-rules-candidate.js" "--live-candidate"
    if ($LASTEXITCODE -ne 0) {
        Fail "the exact fail-closed order admission rules are not live"
    }
    $Release = Read-ProtectedRelease
}

if ($Mode -eq "CANARY") {
    if ($null -eq $Current -or
        "$($Current.mode)" -ne "BLOCKED" -or
        $Current.enabled -ne $false -or
        [long]$Current.minimum_client_version_code -ne $MinimumClientVersionCode -or
        -not [string]::IsNullOrEmpty("$($Current.allowed_uid)") -or
        -not [string]::IsNullOrEmpty("$($Current.allowed_date)")) {
        Fail "CANARY may open only from the exact matching BLOCKED control"
    }
    Verify-InstalledCanary $Release
}
if ($Mode -eq "VERSION") {
    if ($null -eq $Current -or
        "$($Current.mode)" -ne "CANARY" -or
        $Current.enabled -ne $true -or
        [long]$Current.minimum_client_version_code -ne $MinimumClientVersionCode) {
        Fail "VERSION may open only from the exact matching live CANARY"
    }
    Verify-CanaryPass $Current $Release
}

$Payload = [ordered]@{
    enabled = $Enabled
    mode = $Mode
    generation = $Generation
    evidence_id = $EvidenceId
    minimum_client_version_code = $MinimumClientVersionCode
    allowed_uid = $AllowedUid
    allowed_date = $AllowedDate
}
$PayloadJson = $Payload | ConvertTo-Json -Compress

Push-Location $Root
try {
    if (-not $Execute) {
        Write-Output "QP_ORDER_SYNC_CONTROL=DRY_RUN_PASS"
        Write-Output "target=$Target"
        Write-Output $PayloadJson
        Write-Output "No RTDB value was changed."
        exit 0
    }

    if ($env:QP_ORDER_SYNC_CONTROL_APPROVED -ne "YES") {
        Fail "Execute requires QP_ORDER_SYNC_CONTROL_APPROVED=YES"
    }
    if ($Mode -eq "CANARY" -and $env:QP_ORDER_SYNC_CANARY_APPROVED -ne "INSTALLED") {
        Fail "CANARY Execute requires QP_ORDER_SYNC_CANARY_APPROVED=INSTALLED"
    }
    if ($Mode -eq "VERSION" -and $env:QP_ORDER_SYNC_VERSION_APPROVED -ne "CAN-F01_PASS") {
        Fail "VERSION Execute requires QP_ORDER_SYNC_VERSION_APPROVED=CAN-F01_PASS"
    }

    $TempFile = Join-Path ([System.IO.Path]::GetTempPath()) (
        "qp-order-sync-control-{0}.json" -f [guid]::NewGuid().ToString("N")
    )
    try {
        [System.IO.File]::WriteAllText(
            $TempFile,
            $PayloadJson,
            [System.Text.UTF8Encoding]::new($false)
        )
        & $Firebase.Source database:set $Target $TempFile --project $Project --instance $Instance --force
        if ($LASTEXITCODE -ne 0) {
            Fail "order_sync_control publish failed"
        }
    } finally {
        if (Test-Path -LiteralPath $TempFile) {
            Remove-Item -LiteralPath $TempFile -Force
        }
    }

    $Readback = Read-FirebaseJson $Target "published order_sync_control"
    if ($null -eq $Readback -or
        [bool]$Readback.enabled -ne $Enabled -or
        "$($Readback.mode)" -ne $Mode -or
        [long]$Readback.generation -ne $Generation -or
        "$($Readback.evidence_id)" -ne $EvidenceId -or
        [long]$Readback.minimum_client_version_code -ne $MinimumClientVersionCode -or
        "$($Readback.allowed_uid)" -ne $AllowedUid -or
        "$($Readback.allowed_date)" -ne $AllowedDate) {
        Fail "published control did not exact-readback"
    }
    Write-Output "QP_ORDER_SYNC_CONTROL=PASS mode=$Mode generation=$Generation"
} finally {
    Pop-Location
}
