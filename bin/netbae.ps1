# netbae - manage netBae on Windows. Installed to %ProgramFiles%\netBae\bin (on the PATH) with netbae.cmd,
# so `netbae status` works from cmd.exe and PowerShell alike.
$ErrorActionPreference = 'Stop'

$Repo = '__NETBAE_REPO__'   # filled in by install.ps1
$AppDir = Join-Path $env:ProgramFiles 'netBae'
$DataDir = Join-Path $env:ProgramData 'netBae'
$Conf = Join-Path $DataDir 'config.toml'
$Log = Join-Path $DataDir 'netbae.log'
$TaskName = 'netBae'
# the Python 3.11+ chosen by the installer
$Py = if (Test-Path "$AppDir\python.txt") { (Get-Content "$AppDir\python.txt" -Raw).Trim() } else { 'python' }

$Command = if ($args.Count) { "$($args[0])".ToLower() } else { 'help' }
$Rest = @($args | Select-Object -Skip 1)

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}
# Re-run this command in an elevated window (UAC prompt) and wait for it.
function Invoke-Elevated([switch]$KeepOpen) {
    $a = "-NoProfile -ExecutionPolicy Bypass $(if ($KeepOpen) { '-NoExit ' })-File `"$PSCommandPath`" $Command $($Rest -join ' ')"
    $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
    exit $p.ExitCode
}
function Get-Version {
    if ((Test-Path "$AppDir\netbae.py") -and ((Get-Content "$AppDir\netbae.py" -Raw) -match '(?m)^VERSION = "(.*)"')) { $Matches[1] } else { 'unknown' }
}
function Invoke-Check([switch]$Quiet) {
    if ($Quiet) { & $Py "$AppDir\netbae.py" -c $Conf --check-config | Out-Null } else { & $Py "$AppDir\netbae.py" -c $Conf --check-config | Out-Host }
    $LASTEXITCODE -eq 0
}
function Get-NetBaeProcess {
    Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$AppDir\netbae.py*" }
}
function Stop-NetBae {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-NetBaeProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-Process speedtest -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$AppDir\*" } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
function Start-NetBae { Start-ScheduledTask -TaskName $TaskName }

switch ($Command) {
    { $_ -in 'update', 'upgrade' } {
        if (-not (Test-Admin)) { Invoke-Elevated -KeepOpen }
        Write-Host "Installed: netBae $(Get-Version). Fetching the latest from github.com/$Repo ..."
        $env:NETBAE_REPO = $Repo
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-RestMethod "https://raw.githubusercontent.com/$Repo/main/install.ps1" | Invoke-Expression
    }
    'status' {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task) { Write-Host 'netBae is not installed (no scheduled task)'; exit 3 }
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        $proc = Get-NetBaeProcess | Select-Object -First 1
        Write-Host "  netBae $(Get-Version)"
        Write-Host "  task:       $($task.State) (last run $($info.LastRunTime), result $($info.LastTaskResult))"
        if ($proc) {
            $ports = Get-NetTCPConnection -State Listen -OwningProcess $proc.ProcessId -ErrorAction SilentlyContinue |
                ForEach-Object LocalPort | Sort-Object -Unique
            Write-Host "  process:    pid $($proc.ProcessId), listening on port $($ports -join ', ')"
        } else {
            Write-Host '  process:    not running'
            exit 3
        }
    }
    'logs' { Get-Content $Log -Tail 50 -Wait }
    'restart' {
        if (-not (Test-Admin)) { Invoke-Elevated }
        Stop-NetBae; Start-NetBae; Write-Host 'restarted'
    }
    'stop' {
        if (-not (Test-Admin)) { Invoke-Elevated }
        Stop-NetBae
    }
    'start' {
        if (-not (Test-Admin)) { Invoke-Elevated }
        Start-NetBae
    }
    'config' {
        if (-not (Test-Admin)) { Invoke-Elevated }
        $editor = if ($env:EDITOR) { $env:EDITOR } else { 'notepad.exe' }
        Start-Process $editor -ArgumentList "`"$Conf`"" -Wait
        if (Invoke-Check -Quiet) {
            Stop-NetBae; Start-NetBae; Write-Host 'config OK - netBae restarted'
        } else {
            Write-Host 'config has errors - not restarted' -ForegroundColor Red; exit 1
        }
    }
    'check' { if (-not (Invoke-Check)) { exit 1 } }
    'version' { Write-Host "netBae $(Get-Version)" }
    'uninstall' {
        $purge = $Rest | Where-Object { $_ -in '-purge', '--purge', '/purge' }
        $tmp = Join-Path $env:TEMP 'netbae-uninstall.ps1'   # run from outside the folder it deletes
        Copy-Item "$AppDir\uninstall.ps1" $tmp -Force
        if ($purge) { & $tmp -Purge -Deferred } else { & $tmp -Deferred }
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
    default {
        Write-Host @'
netbae - manage the netBae internet monitor

  netbae update       update to the latest version (keeps config + data)
  netbae status       scheduled task and process status
  netbae logs         follow the log
  netbae config       edit the config, validate it and restart
  netbae check        validate the config and show the next speedtest times
  netbae restart | start | stop
  netbae version
  netbae uninstall [-Purge]
'@
    }
}
