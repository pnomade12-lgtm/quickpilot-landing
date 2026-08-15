param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("beta", "gwanje")]
    [string]$Channel,

    [switch]$Execute
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Assert-QpActionPermit.ps1")

$projectId = "quickpilot-39d72"
$databaseInstance = "quickpilot-39d72-default-rtdb"
$repoRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $repoRoot "public"
$manifestPath = Join-Path $publicDir "qp-update.json"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "qp-update.json을 찾을 수 없습니다: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = $manifest.$Channel
if ($null -eq $entry) {
    throw "qp-update.json에 $Channel 채널이 없습니다."
}

$expectedApk = "qp-$Channel.apk"
$versionCode = [long]$entry.versionCode
$versionName = [string]$entry.versionName
$apk = [string]$entry.apk

if ($versionCode -lt 1) {
    throw "versionCode가 올바르지 않습니다: $versionCode"
}
if ([string]::IsNullOrWhiteSpace($versionName)) {
    throw "versionName이 비어 있습니다."
}
if ($apk -ne $expectedApk) {
    throw "APK 파일명이 채널과 다릅니다. 예상: $expectedApk, 실제: $apk"
}
$apkPath = Join-Path $publicDir $apk
if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
    throw "배포 APK를 찾을 수 없습니다: $apk"
}

$buildToolsRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk\build-tools"
$aapt = Get-ChildItem -LiteralPath $buildToolsRoot -Filter aapt.exe -File -Recurse -ErrorAction Stop |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if ($null -eq $aapt) {
    throw "APK 검증용 aapt.exe를 찾을 수 없습니다."
}

$badging = (& $aapt.FullName dump badging $apkPath 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
    throw "APK 정보를 읽지 못했습니다: $apk"
}
$packageMatch = [regex]::Match($badging, "package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'")
if (-not $packageMatch.Success) {
    throw "APK package 정보를 해석하지 못했습니다: $apk"
}
if ($packageMatch.Groups[1].Value -ne "com.quickpilot.v1.beta") {
    throw "APK applicationId가 다릅니다: $($packageMatch.Groups[1].Value)"
}
if ([long]$packageMatch.Groups[2].Value -ne $versionCode) {
    throw "APK와 manifest의 versionCode가 다릅니다."
}
if ($packageMatch.Groups[3].Value -cne $versionName) {
    throw "APK와 manifest의 versionName이 다릅니다."
}

$payload = [ordered]@{
    versionCode = $versionCode
    versionName = $versionName
    apk = $apk
}
$payloadJson = $payload | ConvertTo-Json -Compress
$targetPath = "/v1/app/update_signal/$Channel"

if (-not $Execute) {
    Write-Output "DRY_RUN: Hosting 배포 성공 확인 뒤 -Execute로 실시간 업데이트 신호를 보냅니다."
    Write-Output "target=$targetPath"
    Write-Output $payloadJson
    exit 0
}

$firebase = Get-Command firebase.cmd -ErrorAction Stop
$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("qp-update-signal-{0}-{1}.json" -f $Channel, [guid]::NewGuid().ToString("N"))
$remoteApkFile = Join-Path ([System.IO.Path]::GetTempPath()) ("qp-update-remote-{0}-{1}.apk" -f $Channel, [guid]::NewGuid().ToString("N"))

try {
    $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $remoteUrl = "https://quickpilot-39d72.web.app/${apk}?signal_check=$cacheBuster"
    Invoke-WebRequest -Uri $remoteUrl -OutFile $remoteApkFile -UseBasicParsing
    $localHash = (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash
    $remoteHash = (Get-FileHash -LiteralPath $remoteApkFile -Algorithm SHA256).Hash
    if ($localHash -cne $remoteHash) {
        throw "Hosting APK와 로컬 APK의 SHA256이 다릅니다. 업데이트 신호를 보내지 않습니다."
    }

    Assert-QpActionPermit -Action "UPDATE_SIGNAL"
    [System.IO.File]::WriteAllText($tempFile, $payloadJson, [System.Text.UTF8Encoding]::new($false))
    & $firebase.Source database:set $targetPath $tempFile --project $projectId --instance $databaseInstance --force
    if ($LASTEXITCODE -ne 0) {
        throw "업데이트 실시간 신호 전송에 실패했습니다. Firebase 종료 코드: $LASTEXITCODE"
    }
    Write-Output "업데이트 실시간 신호 전송 완료: $Channel versionCode=$versionCode"
}
finally {
    if (Test-Path -LiteralPath $tempFile) {
        Remove-Item -LiteralPath $tempFile -Force
    }
    if (Test-Path -LiteralPath $remoteApkFile) {
        Remove-Item -LiteralPath $remoteApkFile -Force
    }
}
