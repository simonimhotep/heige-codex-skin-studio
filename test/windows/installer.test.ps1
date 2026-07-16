$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$script:RepositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$script:InstallerPath = Join-Path $script:RepositoryRoot "scripts\windows\install.ps1"
$script:InstallerSource = [System.IO.File]::ReadAllText($script:InstallerPath)

try {
    Test-Case "Installer parses in the active PowerShell runtime" {
        $tokens = $null
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $script:InstallerPath,
            [ref]$tokens,
            [ref]$errors
        ) | Out-Null
        Assert-Equal 0 @($errors).Count
    }

    Test-Case "Installer exposes the supported named parameters" {
        $command = Get-Command -Name $script:InstallerPath -ErrorAction Stop
        $names = @($command.Parameters.Keys)
        Assert-True ($names -contains "InstallRoot")
        Assert-True ($names -contains "StartMenuRoot")
        Assert-True ($names -contains "SkipApply")
    }

    Test-Case "Installer rejects an unknown parameter before executing its body" {
        $hostPath = (Get-Process -Id $PID).Path
        $suffix = [guid]::NewGuid().ToString("N")
        $stdout = Join-Path ([System.IO.Path]::GetTempPath()) "heige-installer-$suffix.out"
        $stderr = Join-Path ([System.IO.Path]::GetTempPath()) "heige-installer-$suffix.err"
        $arguments = @("-NoLogo", "-NoProfile")
        if ($PSVersionTable.PSEdition -eq "Desktop") {
            $arguments += @("-ExecutionPolicy", "Bypass")
        }
        $arguments += @("-File", $script:InstallerPath, "-DefinitelyUnknownParameter")
        try {
            $process = Start-Process -FilePath $hostPath -ArgumentList $arguments `
                -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            $output = ""
            if (Test-Path -LiteralPath $stdout) {
                $output += [System.IO.File]::ReadAllText($stdout)
            }
            if (Test-Path -LiteralPath $stderr) {
                $output += [System.IO.File]::ReadAllText($stderr)
            }
            Assert-True ($process.ExitCode -ne 0) "unknown parameter unexpectedly succeeded"
            Assert-Match "DefinitelyUnknownParameter" $output
        } finally {
            Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
        }
    }

    Test-Case "Durable skeleton precedes participant preparation" {
        $skeleton = $script:InstallerSource.IndexOf(
            'Write-HeiGeInstallJournal -Path $journalPath -Document $journal -Exclusive',
            [System.StringComparison]::Ordinal
        )
        $prepare = $script:InstallerSource.IndexOf(
            '"participant-prepare"',
            [System.StringComparison]::Ordinal
        )
        Assert-True ($skeleton -ge 0) "durable skeleton write is missing"
        Assert-True ($prepare -gt $skeleton) "participant preparation precedes the durable skeleton"
    }

    Test-Case "Installer has one artifact commit decision and write-through replacement" {
        $commits = [regex]::Matches($script:InstallerSource, '-Decision\s+"commit"')
        Assert-Equal 1 $commits.Count
        Assert-Match '\$stream\.Flush\(\$true\)' $script:InstallerSource
        Assert-Match '\[System\.IO\.FileOptions\]::WriteThrough' $script:InstallerSource
        Assert-Match '\[System\.IO\.File\]::Replace' $script:InstallerSource
    }

    Test-Case "Precommit compensation reverses Start Menu before tree" {
        $undo = $script:InstallerSource.IndexOf(
            "function Undo-HeiGeWindowsInstall",
            [System.StringComparison]::Ordinal
        )
        $menu = $script:InstallerSource.IndexOf(
            "Rollback-HeiGeStartMenuShortcut",
            $undo,
            [System.StringComparison]::Ordinal
        )
        $tree = $script:InstallerSource.IndexOf(
            "-Action rollback",
            $menu,
            [System.StringComparison]::Ordinal
        )
        Assert-True ($undo -ge 0 -and $menu -gt $undo -and $tree -gt $menu)
    }

    Complete-TestRun
} catch {
    throw
}
