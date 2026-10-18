# Removes netBae from Windows. Pass -Purge to also delete the config, database and log.
#   powershell -ExecutionPolicy Bypass -File "C:\Program Files\netBae\uninstall.ps1" [-Purge]
#   or: netbae uninstall [-Purge]
# -Deferred (used by `netbae uninstall`) leaves bin\netbae.cmd, which deletes the folder itself when it finishes.
param([switch]$Purge, [switch]$Deferred)
$ErrorActionPreference = 'Stop'

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $a = "-NoProfile -ExecutionPolicy RemoteSigned -File `"$PSCommandPath`""
    if ($Purge) { $a += ' -Purge' }
    if ($Deferred) { $a += ' -Deferred' }
    $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
    exit $p.ExitCode
}

$AppDir = Join-Path $env:ProgramFiles 'netBae'
$DataDir = Join-Path $env:ProgramData 'netBae'
$TaskName = 'netBae'

# Machine PATH via the registry, keeping it REG_EXPAND_SZ (%SystemRoot% entries stay unexpanded).
function Set-MachinePath([scriptblock]$change) {
    $key = Get-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    $old = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $new = (& $change (($old -split ';') | Where-Object { $_ })) -join ';'
    if ($new -ne $old) {
        Set-ItemProperty $key.PSPath -Name Path -Value $new -Type ExpandString
        # setting any variable through .NET broadcasts WM_SETTINGCHANGE so new terminals see the PATH
        [Environment]::SetEnvironmentVariable('NETBAE_PATH_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('NETBAE_PATH_REFRESH', $null, 'User')
    }
}

# netbae tunnel: the Cloudflare task, and a Tailscale Funnel pointing at netBae's public port
if (Get-ScheduledTask -TaskName 'netBae tunnel' -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName 'netBae tunnel' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'netBae tunnel' -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$DataDir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
$pport = if ((Test-Path "$DataDir\config.toml") -and ((Get-Content "$DataDir\config.toml" -Raw) -match '(?ms)^\[public\][^\[]*?^port *= *(\d+)')) { $Matches[1] } else { '8080' }
if ((Test-Path $ts) -and ((& $ts funnel status 2>$null) | Out-String) -like "*127.0.0.1:$pport*") { & $ts funnel --https=443 off *> $null }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (Get-ScheduledTask -TaskName 'netBae update' -ErrorAction SilentlyContinue) {  # the dashboard's Update button
    Unregister-ScheduledTask -TaskName 'netBae update' -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$AppDir\netbae.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process speedtest -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$AppDir\*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Remove-NetFirewallRule -Name 'netBae-dashboard' -ErrorAction SilentlyContinue

$binDir = "$AppDir\bin"
Set-MachinePath { param($parts) $parts | Where-Object { $_ -ne $binDir } }

Set-Location $env:SystemRoot   # in case the shell is inside the folder being deleted
Start-Sleep -Seconds 1         # let the killed python release its files
if ($Deferred) {
    # run from netbae.cmd: leave that one file, which removes the folder itself once this script returns
    Get-ChildItem $AppDir -Recurse -File | Where-Object FullName -ne "$AppDir\bin\netbae.cmd" | Remove-Item -Force
    Get-ChildItem $AppDir -Directory | Where-Object Name -ne 'bin' | Remove-Item -Recurse -Force
} else {
    Remove-Item $AppDir -Recurse -Force
}
Write-Host 'netBae removed. Python and a winget-installed Ookla speedtest CLI were left installed.'

if ($Purge) {
    Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Config, data and log ($DataDir) were deleted."
} else {
    Write-Host "Config and data ($DataDir) kept. Re-run with -Purge to delete them."
}
