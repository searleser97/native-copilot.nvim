param(
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Result,
    [Parameter(Mandatory = $true)][string]$Snapshot,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Log,
    [Parameter(Mandatory = $true)][string]$Trace
)

$env:NATIVE_COPILOT_E2E_PROFILE = $Profile
$env:NATIVE_COPILOT_E2E_ROOT = $Root
$env:NATIVE_COPILOT_E2E_RESULT = $Result
$env:NATIVE_COPILOT_E2E_SNAPSHOT = $Snapshot
$env:NATIVE_COPILOT_E2E_DATABASE = $Database
$env:NATIVE_COPILOT_E2E_TRACE = $Trace

& nvim.exe --clean --cmd "lua vim.g.start_mode = 'ai'" "-V1$Log" -S (Join-Path $Root 'test\visible_e2e.lua')
if ($LASTEXITCODE -ne 0 -and -not (Test-Path -LiteralPath $Result)) {
    Set-Content -LiteralPath $Result -Value "FAIL Neovim exited with code $LASTEXITCODE"
}
