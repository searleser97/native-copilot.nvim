param(
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Result,
    [Parameter(Mandatory = $true)][string]$Snapshot,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Log,
    [Parameter(Mandatory = $true)][string]$Trace,
    [switch]$Observe
)

$env:NATIVE_COPILOT_E2E_PROFILE = $Profile
$env:NATIVE_COPILOT_E2E_ROOT = $Root
$env:NATIVE_COPILOT_E2E_RESULT = $Result
$env:NATIVE_COPILOT_E2E_SNAPSHOT = $Snapshot
$env:NATIVE_COPILOT_E2E_DATABASE = $Database
$env:NATIVE_COPILOT_E2E_TRACE = $Trace
$env:NATIVE_COPILOT_E2E_OBSERVE = if ($Observe) { '1' } else { '0' }
$env:NATIVE_COPILOT_E2E_TELESCOPE = Join-Path $env:LOCALAPPDATA 'nvim-data\lazy\telescope.nvim'
$env:NATIVE_COPILOT_E2E_PLENARY = Join-Path $env:LOCALAPPDATA 'nvim-data\lazy\plenary.nvim'
$env:NATIVE_COPILOT_E2E_BLINK = Join-Path $env:LOCALAPPDATA 'nvim-data\lazy\blink.cmp'
$env:NATIVE_COPILOT_E2E_SMEAR = Join-Path $env:LOCALAPPDATA 'nvim-data\lazy\smear-cursor.nvim'

$testScript = if ($Profile -eq 'telescope') {
    Join-Path $Root 'test\visible_picker_e2e.lua'
} else {
    Join-Path $Root 'test\visible_e2e.lua'
}
& nvim.exe --clean --cmd "lua vim.g.start_mode = 'ai'" "-V1$Log" -S $testScript
if ($LASTEXITCODE -ne 0 -and -not (Test-Path -LiteralPath $Result)) {
    Set-Content -LiteralPath $Result -Value "FAIL Neovim exited with code $LASTEXITCODE"
}
