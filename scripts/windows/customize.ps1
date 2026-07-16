. (Join-Path $PSScriptRoot "lib\common.ps1")

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$port = if ($env:HEIGE_CODEX_SKIN_PORT) { [int]$env:HEIGE_CODEX_SKIN_PORT } else { 9341 }

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "选择一张皮肤主图"
$dialog.Filter = "图片|*.png;*.jpg;*.jpeg;*.webp"
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }

Add-Type -AssemblyName Microsoft.VisualBasic
$name = [Microsoft.VisualBasic.Interaction]::InputBox("给皮肤起个名字", "HeiGe Codex Skin Studio", "我的 Codex 皮肤")
if (-not $name) { exit 0 }

$node = Get-NodeRuntime -AppPath (Get-CodexApp)
$result = & $node (Join-Path $root "src\cli.mjs") create --image $dialog.FileName --name $name | ConvertFrom-Json
Start-CodexWithCdp -Port $port
& $node (Join-Path $root "src\cli.mjs") apply --theme $result.id --port $port
Write-Host "新皮肤已创建并应用：$($result.id)"
