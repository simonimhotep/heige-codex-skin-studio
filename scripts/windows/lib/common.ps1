# HeiGe Codex Skin Studio 公共函数（Windows）
$ErrorActionPreference = "Stop"

function Get-CodexApp {
    # 用户显式指定的路径优先，装在非默认位置时用这个兜底
    if ($env:HEIGE_CODEX_APP) {
        if (Test-Path $env:HEIGE_CODEX_APP) { return $env:HEIGE_CODEX_APP }
        throw "环境变量 HEIGE_CODEX_APP 指向的文件不存在：$($env:HEIGE_CODEX_APP)"
    }

    $exeNames = @("ChatGPT.exe", "Codex.exe")

    # 正在运行的客户端进程路径最可信
    foreach ($proc in (Get-Process -Name "ChatGPT", "Codex" -ErrorAction SilentlyContinue)) {
        if ($proc.Path -and (Test-Path $proc.Path)) { return $proc.Path }
    }

    # 常见安装根目录，含 Squirrel 风格的 app-x.y.z 子目录
    $roots = @(
        (Join-Path $env:LOCALAPPDATA "Programs\ChatGPT"),
        (Join-Path $env:LOCALAPPDATA "Programs\Codex"),
        (Join-Path $env:LOCALAPPDATA "ChatGPT"),
        (Join-Path $env:LOCALAPPDATA "Codex"),
        (Join-Path $env:ProgramFiles "ChatGPT"),
        (Join-Path $env:ProgramFiles "Codex")
    )
    if (${env:ProgramFiles(x86)}) {
        $roots += (Join-Path ${env:ProgramFiles(x86)} "ChatGPT")
        $roots += (Join-Path ${env:ProgramFiles(x86)} "Codex")
    }
    foreach ($root in $roots) {
        foreach ($name in $exeNames) {
            $direct = Join-Path $root $name
            if (Test-Path $direct) { return $direct }
        }
        if (Test-Path $root) {
            $appDirs = Get-ChildItem $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending
            foreach ($dir in $appDirs) {
                foreach ($name in $exeNames) {
                    $nested = Join-Path $dir.FullName $name
                    if (Test-Path $nested) { return $nested }
                }
            }
        }
    }

    # 注册表卸载信息里找安装位置
    $uninstallKeys = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($entry in (Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue)) {
        if ($entry.DisplayName -notmatch "ChatGPT|Codex") { continue }
        $found = @()
        if ($entry.DisplayIcon) { $found += ($entry.DisplayIcon -split ",")[0].Trim('"') }
        if ($entry.InstallLocation) {
            foreach ($name in $exeNames) { $found += (Join-Path $entry.InstallLocation $name) }
        }
        foreach ($path in $found) {
            if ($path -and $path -like "*.exe" -and $path -notmatch "unins|setup|update" -and (Test-Path $path)) {
                return $path
            }
        }
    }

    # 开始菜单快捷方式兜底
    $shell = New-Object -ComObject WScript.Shell
    $menus = @(
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
        (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs")
    )
    foreach ($menu in $menus) {
        if (-not (Test-Path $menu)) { continue }
        $links = Get-ChildItem $menu -Recurse -Filter "*.lnk" -ErrorAction SilentlyContinue |
            Where-Object { $_.BaseName -match "ChatGPT|Codex" }
        foreach ($lnk in $links) {
            $target = $shell.CreateShortcut($lnk.FullName).TargetPath
            if ($target -and $target -like "*.exe" -and $target -notmatch "unins|setup|update" -and (Test-Path $target)) {
                return $target
            }
        }
    }

    throw @"
未找到 Codex Desktop。分两种情况处理：
1. 还没装：先去官网下载安装官方客户端，装完重新运行本脚本。
2. 已经装了但位置特殊：找到客户端 exe 的完整路径（右键开始菜单图标 -> 打开文件位置），
   然后在命令行执行（路径换成你的）：
     setx HEIGE_CODEX_APP "D:\Apps\Codex\Codex.exe"
   关掉本窗口，重新打开再运行一次。
"@
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
