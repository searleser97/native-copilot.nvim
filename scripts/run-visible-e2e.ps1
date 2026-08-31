param(
    [ValidateSet('all', 'allow-all', 'allow-all-mcp', 'manual-permissions')]
    [string]$Profile = 'all'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root '.e2e-artifacts'
$profiles = if ($Profile -eq 'all') {
    @('allow-all', 'allow-all-mcp', 'manual-permissions')
} else {
    @($Profile)
}
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null

Add-Type -Namespace NativeCopilotE2E -Name NativeWindow -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
'@

foreach ($current in $profiles) {
    $result = Join-Path $artifacts "$current-result.txt"
    $snapshot = Join-Path $artifacts "$current-conversation.txt"
    $database = Join-Path $artifacts "$current.sqlite"
    $log = Join-Path $artifacts "$current-nvim.log"
    $trace = Join-Path $artifacts "$current-trace.txt"
    foreach ($path in @(
        $result,
        $snapshot,
        $database,
        "$database-shm",
        "$database-wal",
        $log,
        $trace
    )) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }

    $before = @(Get-Process wezterm-gui -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id)
    $windowScript = Join-Path $root 'scripts\visible-e2e-window.ps1'
    Start-Process -FilePath 'wezterm.exe' -ArgumentList @(
        'start',
        '--always-new-process',
        '--',
        'pwsh.exe',
        '-NoLogo',
        '-NoProfile',
        '-File',
        $windowScript,
        '-Profile',
        $current,
        '-Root',
        $root,
        '-Result',
        $result,
        '-Snapshot',
        $snapshot,
        '-Database',
        $database,
        '-Log',
        $log,
        '-Trace',
        $trace
    ) | Out-Null

    $windowDeadline = [DateTime]::UtcNow.AddSeconds(5)
    $window = $null
    while (-not $window -and [DateTime]::UtcNow -lt $windowDeadline) {
        $window = Get-Process wezterm-gui -ErrorAction SilentlyContinue |
            Where-Object { $_.Id -notin $before } |
            Select-Object -First 1
        if (-not $window) { Start-Sleep -Milliseconds 50 }
    }
    if (-not $window) { throw "Visible E2E profile '$current' did not open WezTerm." }
    [NativeCopilotE2E.NativeWindow]::ShowWindowAsync($window.MainWindowHandle, 3) | Out-Null

    $resultDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $result) -and [DateTime]::UtcNow -lt $resultDeadline) {
        Start-Sleep -Milliseconds 50
    }
    if (-not (Test-Path -LiteralPath $result)) {
        Stop-Process -Id $window.Id -ErrorAction SilentlyContinue
        throw "Visible E2E profile '$current' timed out. Log: $log"
    }

    $lines = @(Get-Content -LiteralPath $result)
    $lines | ForEach-Object { Write-Output "[$current] $_" }
    $failure = $lines | Where-Object { $_ -like 'FAIL *' } | Select-Object -First 1
    $exitDeadline = [DateTime]::UtcNow.AddSeconds(3)
    while (Get-Process -Id $window.Id -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -ge $exitDeadline) {
            Stop-Process -Id $window.Id -ErrorAction SilentlyContinue
            break
        }
        Start-Sleep -Milliseconds 50
    }
    if ($failure) {
        throw "Visible E2E profile '$current' failed. Snapshot: $snapshot"
    }
}
