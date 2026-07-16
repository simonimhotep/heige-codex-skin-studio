param([string]$Theme = "miku-488137")
. (Join-Path $PSScriptRoot "lib\common.ps1")

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$port = if ($env:HEIGE_CODEX_SKIN_PORT) { [int]$env:HEIGE_CODEX_SKIN_PORT } else { 9341 }

Start-CodexWithCdp -Port $port
$node = Get-NodeRuntime -AppPath (Get-CodexApp)
& $node (Join-Path $root "src\cli.mjs") apply --theme $Theme --port $port
Write-Host "皮肤已应用：$Theme"
