. (Join-Path $PSScriptRoot "lib\common.ps1")

$source = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$target = Join-Path $env:USERPROFILE ".codex\heige-codex-skin-studio"
$temp = "$target.tmp.$PID"

if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp -Force | Out-Null
foreach ($item in @("package.json", "src", "themes", "scripts", "custom-pet")) {
    Copy-Item (Join-Path $source $item) -Destination $temp -Recurse
}
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Move-Item $temp $target

Write-Host "HeiGe Codex Skin Studio 已安装到：$target"
if ($env:HEIGE_SKIP_APPLY -ne "1") {
    & (Join-Path $target "scripts\windows\apply.ps1")
}
