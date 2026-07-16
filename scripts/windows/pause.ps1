. (Join-Path $PSScriptRoot "lib\common.ps1")

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$port = if ($env:HEIGE_CODEX_SKIN_PORT) { [int]$env:HEIGE_CODEX_SKIN_PORT } else { 9341 }

if (-not (Test-Cdp -Port $port)) {
    Write-Host "当前没有可移除的实时皮肤。"
    exit 0
}
$node = Get-NodeRuntime -AppPath (Get-CodexApp)
& $node (Join-Path $root "src\cli.mjs") pause --port $port
Write-Host "皮肤已暂停，Codex 原文件从未被修改。"
