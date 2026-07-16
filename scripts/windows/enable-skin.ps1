param(
    [ValidateNotNullOrEmpty()][string]$Theme,
    [ValidateRange(1024, 65535)][int]$Port = 9341
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\entrypoints.ps1")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $PSBoundParameters.ContainsKey("Port") -and $env:HEIGE_CODEX_SKIN_PORT) {
    $Port = [int]$env:HEIGE_CODEX_SKIN_PORT
}
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$arguments = @{ Root = $root; Port = $Port }
if ($PSBoundParameters.ContainsKey("Theme")) { $arguments.Theme = $Theme }
$result = Invoke-HeiGeEnableSkinFlow @arguments
if ($result.ThemeSelection -ceq "explicit") {
    Write-Host "皮肤已应用并开启常驻：$($result.Theme)。下次启动 Codex 会继续使用。"
} else {
    Write-Host "上次使用的皮肤已恢复并开启常驻。下次启动 Codex 会继续使用。"
}
