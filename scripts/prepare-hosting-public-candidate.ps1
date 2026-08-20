param(
  [switch]$Execute,
  [switch]$PairedProtected,
  [ValidateSet("beta", "gwanje")]
  [string]$Channel,
  [string]$BasePublic,
  [string]$CandidatePublic,
  [string]$Artifact,
  [int]$VersionCode,
  [string]$BetaVersionName,
  [string]$GwanjeVersionName
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Assert-QpActionPermit.ps1")

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Public = Join-Path $Root "public"

function Resolve-QpRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$BaseRoot,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $normalized = $RelativePath.Trim().Replace("/", "\")
  $pathSegments = $normalized.Split([IO.Path]::DirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($normalized) -or
      [IO.Path]::IsPathRooted($normalized) -or
      $pathSegments -contains ".." -or
      $normalized -match '[\*\?\[\]]') {
    throw "Unsafe ${Label}: $RelativePath"
  }
  $baseFull = [IO.Path]::GetFullPath($BaseRoot).TrimEnd("\", "/")
  $resolved = [IO.Path]::GetFullPath((Join-Path $baseFull $normalized))
  if (-not $resolved.StartsWith($baseFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "${Label} escaped its approved root: $RelativePath"
  }
  return $resolved
}

function Get-QpApkIdentity {
  param([Parameter(Mandatory = $true)][string]$ApkPath)
  $buildToolsRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk\build-tools"
  $aapt = Get-ChildItem -LiteralPath $buildToolsRoot -Filter aapt.exe -File -Recurse -ErrorAction Stop |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($null -eq $aapt) { throw "APK verifier aapt.exe is missing" }
  $badging = (& $aapt.FullName dump badging $ApkPath 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Could not read APK metadata: $ApkPath" }
  $match = [regex]::Match($badging, "package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'")
  if (-not $match.Success) { throw "Could not parse APK metadata: $ApkPath" }
  return [pscustomobject]@{
    Package = $match.Groups[1].Value
    VersionCode = [int]$match.Groups[2].Value
    VersionName = $match.Groups[3].Value
  }
}

if ($PairedProtected) {
  if ([string]::IsNullOrWhiteSpace($Channel) -or
      [string]::IsNullOrWhiteSpace($BasePublic) -or
      [string]::IsNullOrWhiteSpace($CandidatePublic) -or
      [string]::IsNullOrWhiteSpace($Artifact) -or
      $VersionCode -lt 1 -or
      [string]::IsNullOrWhiteSpace($BetaVersionName) -or
      [string]::IsNullOrWhiteSpace($GwanjeVersionName)) {
    throw "PairedProtected requires Channel, BasePublic, CandidatePublic, Artifact, VersionCode, BetaVersionName, and GwanjeVersionName"
  }
  if (-not $BetaVersionName.StartsWith("beta-", [StringComparison]::Ordinal) -or
      -not $GwanjeVersionName.StartsWith("관제-", [StringComparison]::Ordinal)) {
    throw "PairedProtected visible names do not match their fixed channels"
  }

  $releaseRoot = Join-Path $Root "release-staging"
  $basePath = Resolve-QpRelativePath -RelativePath $BasePublic -BaseRoot $Root.Path -Label "BasePublic"
  $candidatePath = Resolve-QpRelativePath -RelativePath $CandidatePublic -BaseRoot $Root.Path -Label "CandidatePublic"
  $releasePrefix = [IO.Path]::GetFullPath($releaseRoot).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
  if (-not $basePath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not $candidatePath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -or
      $basePath -eq $candidatePath) {
    throw "PairedProtected base and candidate must be distinct exact release-staging directories"
  }
  if (-not (Test-Path -LiteralPath $basePath -PathType Container)) {
    throw "PairedProtected base is missing: $basePath"
  }

  $appRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Root.Path) "QuickPilot_beta")).TrimEnd("\", "/")
  $artifactPath = [IO.Path]::GetFullPath($Artifact)
  if (-not $artifactPath.StartsWith($appRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "PairedProtected artifact must be an exact file inside QuickPilot_beta"
  }

  $identity = Get-QpApkIdentity -ApkPath $artifactPath
  $expectedName = if ($Channel -eq "beta") { $BetaVersionName } else { $GwanjeVersionName }
  if ($identity.Package -cne "com.quickpilot.v1.beta" -or
      $identity.VersionCode -ne $VersionCode -or
      $identity.VersionName -cne $expectedName) {
    throw "PairedProtected artifact metadata mismatch for $Channel"
  }
  if ($Channel -eq "beta" -and (Test-Path -LiteralPath $candidatePath)) {
    throw "PairedProtected beta stage requires a new candidate directory: $candidatePath"
  }
  if ($Channel -eq "gwanje" -and -not (Test-Path -LiteralPath $candidatePath -PathType Container)) {
    throw "PairedProtected gwanje stage requires the beta-staged candidate first: $candidatePath"
  }

  $baseFiles = @(Get-ChildItem -LiteralPath $basePath -File -Recurse -Force)
  $baseBytes = [long](($baseFiles | Measure-Object Length -Sum).Sum)
  $artifactHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Output "QP_HOSTING_STAGE_MODE=PAIRED_PROTECTED"
  Write-Output "QP_HOSTING_STAGE_CHANNEL=$Channel"
  Write-Output "QP_HOSTING_STAGE_BASE=$basePath"
  Write-Output "QP_HOSTING_STAGE_CANDIDATE=$candidatePath"
  Write-Output "QP_HOSTING_STAGE_BASE_FILES=$($baseFiles.Count)"
  Write-Output "QP_HOSTING_STAGE_BASE_BYTES=$baseBytes"
  Write-Output "QP_HOSTING_STAGE_ARTIFACT_SHA256=$artifactHash"

  if (-not $Execute) {
    Write-Output "QP_HOSTING_STAGE_STATUS=DRY_RUN"
    Write-Output "No candidate, public APK, or manifest file was changed."
    exit 0
  }

  Assert-QpActionPermit -Action "HOSTING_STAGE"

  if ($Channel -eq "beta") {
    New-Item -ItemType Directory -Path $candidatePath | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $basePath -Force)) {
      Copy-Item -LiteralPath $item.FullName -Destination $candidatePath -Recurse
    }
  }

  $candidateManifestPath = Join-Path $candidatePath "qp-update.json"
  if (-not (Test-Path -LiteralPath $candidateManifestPath -PathType Leaf)) {
    throw "PairedProtected candidate manifest is missing"
  }
  $manifest = Get-Content -LiteralPath $candidateManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $apkName = if ($Channel -eq "beta") { "qp-beta.apk" } else { "qp-gwanje.apk" }
  $candidateApk = Join-Path $candidatePath $apkName
  Copy-Item -LiteralPath $artifactPath -Destination $candidateApk -Force
  if ($Channel -eq "gwanje") {
    Copy-Item -LiteralPath $artifactPath -Destination (Join-Path $candidatePath "qp-gwanje-latest.apk") -Force
  }

  $entry = $manifest.$Channel
  if ($null -eq $entry) { throw "PairedProtected manifest has no $Channel entry" }
  $entry.versionCode = $VersionCode
  $entry.versionName = $expectedName
  $entry.apk = $apkName
  $entry.sha256 = $artifactHash

  if ($Channel -eq "gwanje") {
    $candidateBeta = Join-Path $candidatePath "qp-beta.apk"
    if (-not (Test-Path -LiteralPath $candidateBeta -PathType Leaf) -or
        [int]$manifest.beta.versionCode -ne $VersionCode -or
        [string]$manifest.beta.versionName -cne $BetaVersionName -or
        [string]$manifest.beta.apk -cne "qp-beta.apk" -or
        [string]$manifest.beta.sha256 -cne (Get-FileHash -LiteralPath $candidateBeta -Algorithm SHA256).Hash.ToLowerInvariant()) {
      throw "PairedProtected beta half is not the exact matching release pair"
    }
  }

  $manifestJson = $manifest | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($candidateManifestPath, $manifestJson + "`n", [Text.UTF8Encoding]::new($false))
  if (-not (Test-Path -LiteralPath $Public -PathType Container)) {
    throw "PairedProtected signal staging public directory is missing"
  }
  if ($Channel -eq "gwanje") {
    Copy-Item -LiteralPath (Join-Path $candidatePath "qp-beta.apk") -Destination (Join-Path $Public "qp-beta.apk") -Force
    Copy-Item -LiteralPath (Join-Path $candidatePath "qp-gwanje.apk") -Destination (Join-Path $Public "qp-gwanje.apk") -Force
    Copy-Item -LiteralPath (Join-Path $candidatePath "qp-gwanje-latest.apk") -Destination (Join-Path $Public "qp-gwanje-latest.apk") -Force
  } else {
    Copy-Item -LiteralPath $candidateApk -Destination (Join-Path $Public $apkName) -Force
  }
  Copy-Item -LiteralPath $candidateManifestPath -Destination (Join-Path $Public "qp-update.json") -Force

  Write-Output "QP_HOSTING_STAGE_STATUS=STAGED"
  Write-Output "QP_HOSTING_STAGE_VERSION_CODE=$VersionCode"
  Write-Output "QP_HOSTING_STAGE_VERSION_NAME=$expectedName"
  exit 0
}

$IncludeFiles = @(
  "index.html",
  "landing-v2.html",
  "guide.html",
  "guide-ops.html",
  "guide-summary.html",
  "monitor-all.html",
  "admin-applications.html",
  "apply.html",
  "server.html",
  "serverops.html",
  "special-memo.html",
  "column-1-ordermap.html",
  "column-2-worktime.html",
  "column-3-crowd.html",
  "column-4-longhaul.html",
  "column-5-cargo-load.html",
  "qp-beta.apk",
  "qp-gwanje-latest.apk",
  "qp-gwanje.apk"
)

$IncludeDirs = @(
  "img/landing",
  "img/guide"
)

$MaxBytes = 70MB
$Rows = @()
$Total = 0L

foreach ($name in $IncludeFiles) {
  $src = Join-Path $Root $name
  if (!(Test-Path -LiteralPath $src)) {
    throw "Missing hosting candidate file: $name"
  }
  $item = Get-Item -LiteralPath $src
  $Total += $item.Length
  $Rows += [PSCustomObject]@{
    Name = $name
    Bytes = $item.Length
    MiB = [Math]::Round($item.Length / 1MB, 3)
    Source = $src
    Target = Join-Path $Public $name
  }
}

foreach ($dir in $IncludeDirs) {
  $srcDir = Join-Path $Root $dir
  if (!(Test-Path -LiteralPath $srcDir)) {
    throw "Missing hosting candidate directory: $dir"
  }
  Get-ChildItem -LiteralPath $srcDir -File -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($Root.Path.Length).TrimStart("\", "/").Replace("\", "/")
    $Total += $_.Length
    $Rows += [PSCustomObject]@{
      Name = $rel
      Bytes = $_.Length
      MiB = [Math]::Round($_.Length / 1MB, 3)
      Source = $_.FullName
      Target = Join-Path $Public $rel
    }
  }
}

if ($Total -gt $MaxBytes) {
  throw ("Hosting public candidate exceeds {0:N0} MiB: {1} bytes / {2:N3} MiB" -f ($MaxBytes / 1MB), $Total, ($Total / 1MB))
}

$guide = Get-Content -LiteralPath (Join-Path $Root "guide.html") -Raw -Encoding UTF8
if ($guide -notmatch "qp-beta\.apk") {
  throw "guide.html does not contain qp-beta.apk link"
}

$Included = @{}
foreach ($name in $IncludeFiles) {
  $Included[$name.ToLowerInvariant()] = $true
}
foreach ($dir in $IncludeDirs) {
  $Included[$dir.ToLowerInvariant().TrimEnd("/") + "/"] = $true
}

$LinkIssues = @()
foreach ($row in ($Rows | Where-Object { $_.Name -like "*.html" })) {
  $html = Get-Content -LiteralPath $row.Source -Raw -Encoding UTF8
  $matches = [regex]::Matches($html, "(?i)\b(?:href|src)\s*=\s*['""]([^'""]+)['""]")
  foreach ($m in $matches) {
    $link = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value).Trim()
    if (!$link -or $link.StartsWith("#")) { continue }
    if ($link -match "^(https?:|mailto:|tel:|javascript:|data:)") { continue }
    $path = ($link -split "[?#]", 2)[0].Replace("\", "/").TrimStart("./")
    if ($path -notmatch "\.(html|png|jpg|jpeg|webp|gif|svg|css|js|ico|apk|json)$") { continue }
    $leaf = Split-Path $path -Leaf
    $lowerPath = $path.ToLowerInvariant()
    $coveredByDir = $false
    foreach ($dir in $IncludeDirs) {
      if ($lowerPath.StartsWith($dir.ToLowerInvariant().TrimEnd("/") + "/")) {
        $coveredByDir = $true
        break
      }
    }
    if (!$coveredByDir -and !$Included.ContainsKey($leaf.ToLowerInvariant())) {
      $LinkIssues += [PSCustomObject]@{
        Source = $row.Name
        Link = $link
        MissingCandidate = $leaf
      }
    }
  }
}

if ($LinkIssues.Count -gt 0) {
  $details = $LinkIssues | Format-Table Source,Link,MissingCandidate -AutoSize | Out-String
  throw "Hosting public candidate has relative HTML links missing from IncludeFiles:`n$details"
}

Write-Output ("Hosting public candidate size ok: {0} bytes / {1:N3} MiB" -f $Total, ($Total / 1MB))
Write-Output "Included files:"
$Rows | Format-Table Name,Bytes,MiB -AutoSize | Out-String | Write-Output

if (!$Execute) {
  Write-Output "Dry run only. Re-run with -Execute after director approval to create public and copy candidate files."
  Write-Output "No files were copied."
  exit 0
}

Assert-QpActionPermit -Action "HOSTING_STAGE"

if (!(Test-Path -LiteralPath $Public)) {
  New-Item -ItemType Directory -Path $Public | Out-Null
}

foreach ($row in $Rows) {
  $targetDir = Split-Path -Parent $row.Target
  if (!(Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  }
  Copy-Item -LiteralPath $row.Source -Destination $row.Target -Force
}

Write-Output "Public candidate files copied. Deploy is still a separate director-approved step."
