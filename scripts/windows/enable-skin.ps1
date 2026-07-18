param(
    [ValidateNotNullOrEmpty()][string]$Theme,
    [ValidateRange(1024, 65535)][int]$Port = 9341
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\entrypoints.ps1")
. (Join-Path $PSScriptRoot "lib\bat-exit.ps1")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $PSBoundParameters.ContainsKey("Port") -and $env:HEIGE_CODEX_SKIN_PORT) {
    $Port = [int]$env:HEIGE_CODEX_SKIN_PORT
}
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$arguments = @{ Root = $root; Port = $Port }
if ($PSBoundParameters.ContainsKey("Theme")) { $arguments.Theme = $Theme }

Invoke-HeiGeBatEntrypoint {
    $result = Invoke-HeiGeEnableSkinFlow @arguments
    if ($result.ThemeSelection -ceq "explicit") {
        Write-Host "皮肤已应用到当前会话：$($result.Theme)。下次仍需常驻，请在 Codex 顶部打开「皮肤常驻」开关。"
    } else {
        Write-Host "上次使用的皮肤已恢复到当前会话。下次仍需常驻，请在 Codex 顶部打开「皮肤常驻」开关。"
    }
}
