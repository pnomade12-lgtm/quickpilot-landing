param(
    [switch]$Execute,
    [string]$Project = "quickpilot-39d72",
    [string]$DatabaseUrl = "https://quickpilot-39d72-default-rtdb.asia-southeast1.firebasedatabase.app",
    [string]$FunctionUrl = "https://asia-southeast1-quickpilot-39d72.cloudfunctions.net/agencyStatsDailyNow",
    [string]$Key = "qpmon610"
)

$ErrorActionPreference = "Stop"

firebase projects:list --json | Out-Null
$configPath = Join-Path $env:USERPROFILE ".config\configstore\firebase-tools.json"
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$token = $config.tokens.access_token
if (-not $token) { throw "Firebase access token not found" }
$headers = @{ Authorization = "Bearer $token" }

$latest = Invoke-RestMethod -Method Get -Uri "$DatabaseUrl/v1/app/insung_agency_stats_meta/latest.json" -Headers $headers
$coveredTo = [string]$latest.statsWindowTo
if ($coveredTo -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "Invalid statsWindowTo: $coveredTo" }

$daily = Invoke-RestMethod -Method Get -Uri "$DatabaseUrl/v1/app/insung_agency_stats_daily.json?shallow=true" -Headers $headers
$done = @{}
if ($daily) {
    foreach ($property in $daily.PSObject.Properties) { $done[$property.Name] = $true }
}

$kstNow = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(9))
$endDate = $kstNow.Date.AddDays(-1)
$cursor = [datetime]::ParseExact($coveredTo, "yyyy-MM-dd", $null).AddDays(1)
$pending = [System.Collections.Generic.List[string]]::new()
while ($cursor -le $endDate) {
    $date = $cursor.ToString("yyyy-MM-dd")
    if (-not $done.ContainsKey($date)) { $pending.Add($date) }
    $cursor = $cursor.AddDays(1)
}

[PSCustomObject]@{
    mode = if ($Execute) { "EXECUTE" } else { "PLAN_ONLY" }
    coveredTo = $coveredTo
    endDate = $endDate.ToString("yyyy-MM-dd")
    pendingCount = $pending.Count
    pendingDates = $pending -join ","
} | Format-List

if (-not $Execute) { exit 0 }

$results = foreach ($date in $pending) {
    $uri = "${FunctionUrl}?k=$([uri]::EscapeDataString($Key))&date=$date"
    $result = Invoke-RestMethod -Method Get -Uri $uri
    if (-not $result.ok) { throw "Agency stats backfill failed: $date" }
    [PSCustomObject]@{
        date = $date
        skipped = [bool]$result.skipped
        agenciesUpdated = [int]$result.agenciesUpdated
        rawOrderRows = [int]$result.diagnostics.rawOrderRows
        uniqueOrders = [int]$result.diagnostics.uniqueOrders
        userScope = [string]$result.diagnostics.userScope
        lookupSource = [string]$result.diagnostics.agencyLookupSource
    }
}

$results | Format-Table -AutoSize
[PSCustomObject]@{
    completed = @($results).Count
    updatedAgencies = (@($results) | Measure-Object -Property agenciesUpdated -Sum).Sum
    rawOrderRows = (@($results) | Measure-Object -Property rawOrderRows -Sum).Sum
    uniqueOrders = (@($results) | Measure-Object -Property uniqueOrders -Sum).Sum
} | Format-List

$dailyAfter = Invoke-RestMethod -Method Get -Uri "$DatabaseUrl/v1/app/insung_agency_stats_daily.json?shallow=true" -Headers $headers
$latestDoneDate = @($dailyAfter.PSObject.Properties.Name | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}$' } | Sort-Object | Select-Object -Last 1)
if ($latestDoneDate.Count -ne 1) { throw "Latest completed agency stats date not found" }
$latestDone = Invoke-RestMethod -Method Get -Uri "$DatabaseUrl/v1/app/insung_agency_stats_daily/$($latestDoneDate[0]).json" -Headers $headers
if ([string]$latestDone.status -ne "done") { throw "Latest agency stats node is not done: $($latestDoneDate[0])" }
$latestDone | Add-Member -NotePropertyName date -NotePropertyValue $latestDoneDate[0] -Force
$latestBody = $latestDone | ConvertTo-Json -Depth 20 -Compress
Invoke-RestMethod -Method Put -Uri "$DatabaseUrl/v1/app/insung_agency_stats_meta/latestIncremental.json" -Headers $headers -ContentType "application/json" -Body ([Text.Encoding]::UTF8.GetBytes($latestBody)) | Out-Null
Write-Output "latestIncremental=$($latestDoneDate[0])"
