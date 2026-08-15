Set-StrictMode -Version Latest

function Assert-QpActionPermit {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Action,
        [switch]$EmergencyFailClosed
    )

    $landingRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $appRoot = Join-Path (Split-Path -Parent $landingRoot) "QuickPilot_beta"
    $verifier = Join-Path $appRoot "scripts\verify-qp-action-permit.ps1"
    if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
        throw "QP_ACTION_PERMIT_BLOCKED: shared app verifier is missing"
    }

    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $verifier, "-Action", $Action)
    if ($EmergencyFailClosed) {
        $arguments += "-EmergencyFailClosed"
    } else {
        $arguments += "-Consume"
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& powershell.exe @arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $output | ForEach-Object { Write-Output "$_" }
    if ($exitCode -ne 0 -or -not ($output -match "QP_ACTION_PERMIT_STATUS=PASS")) {
        throw "QP_ACTION_PERMIT_BLOCKED: $Action is not authorized by the exact current task"
    }
}
