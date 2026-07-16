# HeiGe Codex Skin Studio Windows entrypoint orchestration
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "scheduled-task.ps1")

function New-HeiGeWindowsEntrypointContext {
    param([Parameter(Mandatory = $true)][string]$Root)
    $resolvedRoot = Get-HeiGeComparablePath -Path $Root
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
        throw "安装目录不存在：$resolvedRoot"
    }
    $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "安装目录不能是 reparse point：$resolvedRoot"
    }

    $cliPath = Join-Path $resolvedRoot "src\cli.mjs"
    $controllerPath = Join-Path $resolvedRoot "scripts\windows\controller.ps1"
    foreach ($path in @($cliPath, $controllerPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Windows 入口依赖文件不存在：$path"
        }
    }
    $app = Resolve-CodexApp
    $runtime = Get-NodeRuntime -App $app
    if (-not $runtime -or -not $runtime.Path -or -not (Test-Path -LiteralPath $runtime.Path -PathType Leaf)) {
        throw "Windows 入口无法验证 Node.js 运行时。"
    }
    $stateDirectory = Resolve-HeiGeScopedStateDirectory -StateDirectory $null
    Protect-HeiGeStateDirectory -Path $stateDirectory | Out-Null
    return [pscustomobject][ordered]@{
        App = $app
        NodePath = [string]$runtime.Path
        CliPath = $cliPath
        ControllerPath = $controllerPath
        StateDirectory = $stateDirectory
        TaskName = $script:HeiGeProductionTaskName
    }
}

function Get-HeiGeFlowContext {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [scriptblock]$ContextProvider
    )
    $values = if ($ContextProvider) {
        @(& $ContextProvider $Root)
    } else {
        @(New-HeiGeWindowsEntrypointContext -Root $Root)
    }
    if ($values.Count -ne 1 -or $null -eq $values[0]) {
        throw "Windows 入口预检结果不唯一。"
    }
    $context = $values[0]
    foreach ($name in @("App", "NodePath", "CliPath", "ControllerPath", "StateDirectory", "TaskName")) {
        if ($context.PSObject.Properties.Name -notcontains $name -or $null -eq $context.$name) {
            throw "Windows 入口预检缺少字段：$name"
        }
    }
    return $context
}

function Invoke-HeiGeContextCli {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [scriptblock]$CliProvider
    )
    $values = if ($CliProvider) {
        @(& $CliProvider $Context $Arguments)
    } else {
        $cliArguments = @([string]$Context.CliPath) + @($Arguments)
        $json = Invoke-SkinCli -Node ([string]$Context.NodePath) -CliArgs $cliArguments
        try {
            @($json | ConvertFrom-Json)
        } catch {
            throw "皮肤命令返回了无效 JSON：$($_.Exception.Message)"
        }
    }
    if ($values.Count -ne 1 -or $null -eq $values[0]) {
        throw "皮肤命令返回结果不唯一。"
    }
    return $values[0]
}

function Assert-HeiGeModeResult {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    if ($Result.PSObject.Properties.Name -notcontains "mode" -or [string]$Result.mode -cne $Expected) {
        throw "皮肤命令状态验证失败：期望 $Expected。"
    }
}

function Assert-HeiGePersistenceResult {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][bool]$Expected
    )
    if ($Result.PSObject.Properties.Name -notcontains "persistenceEnabled" -or
        $Result.persistenceEnabled -isnot [System.Boolean] -or
        [bool]$Result.persistenceEnabled -ne $Expected) {
        throw "常驻状态验证失败：期望 $Expected。"
    }
}

function Start-HeiGeEntrypointCdp {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$StartCdpProvider
    )
    if ($StartCdpProvider) {
        & $StartCdpProvider $Context $Port | Out-Null
    } else {
        Start-CodexWithCdp -Port $Port -AppInfo $Context.App
    }
}

function Require-HeiGeEntrypointCdp {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$RequireCdpProvider
    )
    if ($RequireCdpProvider) {
        & $RequireCdpProvider $Context $Port | Out-Null
        return
    }
    if (-not (Test-CdpEndpoint -Port $Port)) {
        throw "当前 Codex 未开启可归属的 CDP 端口：$Port"
    }
    Get-CdpOwner -Port $Port -App $Context.App | Out-Null
}

function Unregister-HeiGeEntrypointTask {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [scriptblock]$UnregisterProvider
    )
    $values = if ($UnregisterProvider) {
        @(& $UnregisterProvider $Context)
    } else {
        @(Unregister-HeiGeScheduledTask -TaskName ([string]$Context.TaskName) `
            -StateDirectory ([string]$Context.StateDirectory))
    }
    if ($values.Count -ne 1 -or $null -eq $values[0] -or
        $values[0].PSObject.Properties.Name -notcontains "VerifiedAbsent" -or
        $values[0].VerifiedAbsent -isnot [System.Boolean] -or
        -not [bool]$values[0].VerifiedAbsent) {
        throw "Scheduled Task 注销后未能验证任务已消失。"
    }
    return $values[0]
}

function Get-HeiGeEntrypointProcessMode {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [scriptblock]$ProcessProvider
    )
    $records = if ($ProcessProvider) {
        @(& $ProcessProvider $Context)
    } else {
        @(Get-CimInstance -ClassName Win32_Process `
            -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" -ErrorAction Stop)
    }
    $owned = @()
    foreach ($record in $records) {
        if ($null -eq $record) {
            throw "Codex 进程记录为空，无法唯一归属。"
        }
        $propertyNames = @($record.PSObject.Properties.Name)
        $processIdName = if ($propertyNames -contains "ProcessId") {
            "ProcessId"
        } elseif ($propertyNames -contains "Id") {
            "Id"
        } else {
            $null
        }
        $pathName = if ($propertyNames -contains "ExecutablePath") {
            "ExecutablePath"
        } elseif ($propertyNames -contains "Path") {
            "Path"
        } else {
            $null
        }
        if (-not $processIdName -or -not $pathName -or
            $propertyNames -notcontains "ParentProcessId") {
            throw "Codex 进程记录缺少 PID、父 PID 或可执行路径，无法唯一归属。"
        }
        try {
            $path = [string]$record.$pathName
            $processId = 0
            $parentProcessId = 0
            $validProcessId = [int]::TryParse([string]$record.$processIdName, [ref]$processId)
            $validParentId = [int]::TryParse([string]$record.ParentProcessId, [ref]$parentProcessId)
        } catch {
            throw "Codex 进程记录无法安全读取，无法唯一归属。"
        }
        if (-not $path -or -not $validProcessId -or $processId -le 0 -or
            -not $validParentId -or $parentProcessId -lt 0) {
            throw "Codex 进程记录无效，无法唯一归属。"
        }
        $owner = [pscustomobject]@{
            Id = $processId
            Path = $path
            ProcessName = if ($propertyNames -contains "Name") {
                [string]$record.Name
            } elseif ($propertyNames -contains "ProcessName") {
                [string]$record.ProcessName
            } else {
                ""
            }
        }
        if (Test-CdpOwnerMatchesApp -Owner $owner -App $Context.App) {
            $owned += [pscustomobject][ordered]@{
                Id = $processId
                ParentProcessId = $parentProcessId
                Path = Get-HeiGeFullPath -Path $path
            }
        }
    }
    if ($owned.Count -eq 0) { return "closed" }

    $normalized = @()
    foreach ($group in @($owned | Group-Object Id)) {
        $parents = @($group.Group | ForEach-Object { [int]$_.ParentProcessId } | Sort-Object -Unique)
        $paths = @($group.Group | ForEach-Object { [string]$_.Path } | Sort-Object -Unique)
        if ($parents.Count -ne 1 -or $paths.Count -ne 1) {
            throw "同一 Codex PID 存在冲突记录，无法唯一归属。"
        }
        $normalized += [pscustomobject][ordered]@{
            Id = [int]$group.Name
            ParentProcessId = [int]$parents[0]
            Path = [string]$paths[0]
        }
    }
    $ownedIds = @{}
    foreach ($process in $normalized) { $ownedIds[[int]$process.Id] = $true }
    $mainProcesses = @($normalized | Where-Object {
        -not $ownedIds.ContainsKey([int]$_.ParentProcessId)
    })
    if ($mainProcesses.Count -ne 1) {
        throw "Codex 主进程归属不唯一，拒绝判断 closed/native。"
    }
    return "native"
}

function Invoke-HeiGeApplyWithContext {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [AllowNull()][string]$Theme,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$StartCdpProvider,
        [scriptblock]$CliProvider
    )
    Start-HeiGeEntrypointCdp -Context $Context -Port $Port -StartCdpProvider $StartCdpProvider
    $arguments = @("apply")
    if ([string]::IsNullOrWhiteSpace($Theme)) {
        $arguments += "--prefer-stored"
    } else {
        $arguments += @("--theme", $Theme)
    }
    $arguments += @("--port", [string]$Port)
    $result = Invoke-HeiGeContextCli -Context $Context `
        -Arguments $arguments -CliProvider $CliProvider
    Assert-HeiGeModeResult -Result $result -Expected "active"
    return $result
}

function Invoke-HeiGeApplyFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Theme,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$StartCdpProvider,
        [scriptblock]$CliProvider
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    $applied = Invoke-HeiGeApplyWithContext -Context $context -Theme $Theme -Port $Port `
        -StartCdpProvider $StartCdpProvider -CliProvider $CliProvider
    if ($applied.PSObject.Properties.Name -notcontains "persistenceEnabled" -or
        $applied.persistenceEnabled -isnot [System.Boolean]) {
        throw "apply 未返回可验证的常驻状态。"
    }
    return [pscustomobject][ordered]@{
        Mode = "active"
        PersistenceEnabled = [bool]$applied.persistenceEnabled
        PersistenceChanged = $false
        Theme = $Theme
        Completion = "complete"
    }
}

function Invoke-HeiGeEnableSkinFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [AllowNull()][string]$Theme,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$StartCdpProvider,
        [scriptblock]$CliProvider,
        [scriptblock]$UnregisterProvider
    )
    if ($PSBoundParameters.ContainsKey("Theme") -and [string]::IsNullOrWhiteSpace($Theme)) {
        throw "Theme 显式传入时不能为空。"
    }
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    Invoke-HeiGeApplyWithContext -Context $context -Theme $Theme -Port $Port `
        -StartCdpProvider $StartCdpProvider -CliProvider $CliProvider | Out-Null

    try {
        $enabled = Invoke-HeiGeContextCli -Context $context `
            -Arguments @("set-persistence", "true", "--port", [string]$Port) -CliProvider $CliProvider
        Assert-HeiGePersistenceResult -Result $enabled -Expected $true
    } catch {
        $enableError = $_.Exception.Message
        $disabledVerified = $false
        $taskAbsentVerified = $false
        $disableError = $null
        $unregisterError = $null
        try {
            $disabled = Invoke-HeiGeContextCli -Context $context `
                -Arguments @("set-persistence", "false", "--port", [string]$Port) -CliProvider $CliProvider
            Assert-HeiGePersistenceResult -Result $disabled -Expected $false
            $disabledVerified = $true
        } catch {
            $disableError = $_.Exception.Message
        }
        try {
            Unregister-HeiGeEntrypointTask -Context $context `
                -UnregisterProvider $UnregisterProvider | Out-Null
            $taskAbsentVerified = $true
        } catch {
            $unregisterError = $_.Exception.Message
        }
        if ($disabledVerified -and $taskAbsentVerified) {
            throw "常驻启用失败。本次会话皮肤已应用，但常驻保持关闭，计划任务已移除。原始错误：$enableError"
        }
        throw "常驻启用失败，且无法确认权威常驻状态。原始错误：$enableError；关闭补偿：$disableError；任务注销：$unregisterError"
    }
    return [pscustomobject][ordered]@{
        Mode = "active"
        PersistenceEnabled = $true
        Theme = $Theme
        ThemeSelection = if ([string]::IsNullOrWhiteSpace($Theme)) {
            "stored-or-default"
        } else {
            "explicit"
        }
        Completion = "complete"
    }
}

function Invoke-HeiGePauseFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$CliProvider
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    $hasCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $context $Port)
    } else {
        Test-Cdp -Port $Port -App $context.App
    }
    if (-not $hasCdp) {
        return [pscustomobject][ordered]@{
            Mode = "noop"
            PersistenceEnabled = $null
            Completion = "complete"
        }
    }
    $result = Invoke-HeiGeContextCli -Context $context `
        -Arguments @("pause", "--port", [string]$Port) -CliProvider $CliProvider
    Assert-HeiGeModeResult -Result $result -Expected "paused"
    return [pscustomobject][ordered]@{
        Mode = "paused"
        PersistenceEnabled = if ($result.PSObject.Properties.Name -contains "persistenceEnabled") {
            [bool]$result.persistenceEnabled
        } else { $null }
        Completion = "complete"
    }
}

function Invoke-HeiGeResumeFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$RequireCdpProvider,
        [scriptblock]$CliProvider
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    Require-HeiGeEntrypointCdp -Context $context -Port $Port -RequireCdpProvider $RequireCdpProvider
    $result = Invoke-HeiGeContextCli -Context $context `
        -Arguments @("resume", "--port", [string]$Port) -CliProvider $CliProvider
    Assert-HeiGeModeResult -Result $result -Expected "active"
    return [pscustomobject][ordered]@{
        Mode = "active"
        PersistenceEnabled = if ($result.PSObject.Properties.Name -contains "persistenceEnabled") {
            [bool]$result.persistenceEnabled
        } else { $null }
        Completion = "complete"
    }
}

function Invoke-HeiGeRestoreFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CliProvider,
        [scriptblock]$UnregisterProvider,
        [scriptblock]$RestartNativeProvider
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    $hasExactCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $context $Port)
    } else {
        Test-Cdp -Port $Port -App $context.App
    }
    if (-not $hasExactCdp) {
        Get-HeiGeEntrypointProcessMode -Context $context `
            -ProcessProvider $ProcessProvider | Out-Null
    }
    $disabled = Invoke-HeiGeContextCli -Context $context `
        -Arguments @("set-persistence", "false", "--port", [string]$Port) -CliProvider $CliProvider
    Assert-HeiGePersistenceResult -Result $disabled -Expected $false
    $hasExactCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $context $Port)
    } else {
        Test-Cdp -Port $Port -App $context.App
    }
    if ($hasExactCdp) {
        $paused = Invoke-HeiGeContextCli -Context $context `
            -Arguments @("pause", "--port", [string]$Port) -CliProvider $CliProvider
        Assert-HeiGeModeResult -Result $paused -Expected "paused"
    }
    Unregister-HeiGeEntrypointTask -Context $context -UnregisterProvider $UnregisterProvider | Out-Null
    $offlineMode = if ($hasExactCdp) {
        $null
    } else {
        Get-HeiGeEntrypointProcessMode -Context $context -ProcessProvider $ProcessProvider
    }
    if ($hasExactCdp) {
        if ($RestartNativeProvider) {
            & $RestartNativeProvider $context $Port | Out-Null
        } else {
            Restart-CodexWithoutCdp -AppInfo $context.App -Port $Port
        }
    }
    return [pscustomobject][ordered]@{
        Mode = if ($hasExactCdp) { "restoring" } else { $offlineMode }
        PersistenceEnabled = $false
        Completion = "complete"
    }
}
