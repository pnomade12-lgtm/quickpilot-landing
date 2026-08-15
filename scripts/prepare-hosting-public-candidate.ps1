param(
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Assert-QpActionPermit.ps1")

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Public = Join-Path $Root "public"

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
