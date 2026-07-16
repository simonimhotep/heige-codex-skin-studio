# HeiGe Codex Skin Studio 公共函数（Windows）
$ErrorActionPreference = "Stop"

function Get-CodexApp {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\ChatGPT\ChatGPT.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Codex\Codex.exe"),
        (Join-Path $env:ProgramFiles "ChatGPT\ChatGPT.exe"),
        (Join-Path $env:ProgramFiles "Codex\Codex.exe")
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    throw "未找到 Codex Desktop，请确认已安装官方客户端。已探测：$($candidates -join '; ')"
}

function Get-NodeRuntime {
    param([string]$AppPath)
    $appDir = Split-Path $AppPath -Parent
    $candidates = @(
        (Join-Path $appDir "resources\cua_node\node.exe"),
        (Join-Path $appDir "resources\cua_node\bin\node.exe")
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($systemNode) { return $systemNode.Source }
    throw "未找到 Node.js 运行时：Codex 自带 Node 不在预期位置，系统 PATH 里也没有 node。请安装 Node.js 后重试。"
}

function Test-Cdp {
    param([int]$Port)
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Start-CodexWithCdp {
    param([int]$Port = 9341)
    if (Test-Cdp -Port $Port) { return }

    $app = Get-CodexApp
    $running = Get-Process | Where-Object { $_.Path -eq $app } -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "正在正常退出 Codex，以调试端口重新打开……"
        $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
        for ($i = 0; $i -lt 60; $i++) {
            if (-not (Get-Process | Where-Object { $_.Path -eq $app } -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
    }

    Start-Process -FilePath $app -ArgumentList @(
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$Port"
    )
    for ($i = 0; $i -lt 80; $i++) {
        if (Test-Cdp -Port $Port) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Codex 未在 $Port 端口就绪。请彻底退出 Codex 后重试。"
}
