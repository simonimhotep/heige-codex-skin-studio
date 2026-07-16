[CmdletBinding()]
param(
    [AllowNull()]
    [string]$InstallRoot,
    [AllowNull()]
    [string]$StartMenuRoot,
    [switch]$SkipApply
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$skillRoot = Split-Path $PSScriptRoot -Parent
$payloadRoot = Join-Path $skillRoot "payload"
$installer = Join-Path $payloadRoot "scripts\windows\install.ps1"
if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) {
    throw "HeiGe Codex Skin Studio 安装包缺少 payload 目录：$payloadRoot"
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "HeiGe Codex Skin Studio 安装包缺少 Windows 安装器：$installer"
}

& $installer @PSBoundParameters
