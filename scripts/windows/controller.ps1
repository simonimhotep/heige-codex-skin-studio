param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("run", "register", "start", "unregister", "status")]
    [string]$Action,
    [string]$TaskName = "HeiGe Codex Skin Studio Controller",
    [ValidateRange(1024, 65535)]
    [int]$Port = 9341,
    [string]$StateDirectory,
    [Nullable[long]]$ExpectedRevision,
    [string]$ExpectedTransitionNonce,
    [switch]$PreserveHandshake
)

$ErrorActionPreference = "Stop"
$script:WindowsRoot = $PSScriptRoot
$script:RepositoryRoot = Split-Path (Split-Path $script:WindowsRoot -Parent) -Parent
. (Join-Path $script:WindowsRoot "lib\common.ps1")
. (Join-Path $script:WindowsRoot "lib\scheduled-task.ps1")

try {
    $testMode = Test-HeiGeTestTaskName -TaskName $TaskName
    Assert-HeiGeTaskScope -TaskName $TaskName -TestMode:$testMode
    $StateDirectory = Resolve-HeiGeScopedStateDirectory `
        -StateDirectory $StateDirectory -TestMode:$testMode
    $hasExpectedRevision = $PSBoundParameters.ContainsKey("ExpectedRevision")
    $hasExpectedNonce = $PSBoundParameters.ContainsKey("ExpectedTransitionNonce")
    if (($Action -eq "run" -or $Action -eq "register") -and ($hasExpectedRevision -or $hasExpectedNonce)) {
        throw "$Action does not accept expected handshake parameters"
    }
    if (($Action -eq "status" -or $Action -eq "unregister") -and
        ($hasExpectedRevision -or $hasExpectedNonce)) {
        throw "$Action does not accept handshake parameters"
    }
    if ($PreserveHandshake -and $Action -ne "unregister") {
        throw "$Action does not accept PreserveHandshake"
    }

    if ($Action -eq "status") {
        Get-HeiGeScheduledTaskStatus -TaskName $TaskName -StateDirectory $StateDirectory `
            -TestMode:$testMode | ConvertTo-Json -Depth 8
        exit 0
    }

    if ($Action -eq "unregister") {
        Unregister-HeiGeScheduledTask -TaskName $TaskName -StateDirectory $StateDirectory `
            -TestMode:$testMode -PreserveHandshake:$PreserveHandshake | ConvertTo-Json -Depth 8
        exit 0
    }

    if ($Action -eq "start") {
        if ($null -eq $ExpectedRevision -or -not $ExpectedTransitionNonce) {
            throw "start requires ExpectedRevision and ExpectedTransitionNonce"
        }
        Protect-HeiGeStateDirectory -Path $StateDirectory | Out-Null
        Start-HeiGeScheduledTask -TaskName $TaskName -StateDirectory $StateDirectory `
            -ExpectedRevision ([long]$ExpectedRevision) `
            -ExpectedTransitionNonce $ExpectedTransitionNonce -TestMode:$testMode | ConvertTo-Json -Depth 8
        exit 0
    }

    Protect-HeiGeStateDirectory -Path $StateDirectory | Out-Null
    $app = Resolve-CodexApp
    $node = Get-NodeRuntime -App $app

    if ($Action -eq "register") {
        Register-HeiGeScheduledTask -TaskName $TaskName -NodePath $node.Path `
            -ControllerPath $PSCommandPath -StateDirectory $StateDirectory -Port $Port `
            -TestMode:$testMode | ConvertTo-Json -Depth 8
        exit 0
    }

    $cliPath = Join-Path $script:RepositoryRoot "src\cli.mjs"
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw "Node controller CLI 不存在：$cliPath"
    }
    $result = Invoke-HeiGeNodeControllerProcess -NodePath $node.Path -CliPath $cliPath `
        -TaskName $TaskName -Port $Port -StateDirectory $StateDirectory
    if ([string]$result.action -ceq "unregister") {
        & $PSCommandPath -Action "unregister" -TaskName $TaskName -Port $Port `
            -StateDirectory $StateDirectory -PreserveHandshake | Out-Null
        exit 0
    }
    if ([string]$result.action -ceq "error") {
        throw "Node controller 返回 error action。"
    }
    throw "Node controller 以未知 action 退出：$([string]$result.action)"
} catch {
    [Console]::Error.WriteLine("HeiGe Codex Skin Studio Windows controller：$($_.Exception.Message)")
    exit 1
}
