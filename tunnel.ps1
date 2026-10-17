# netbae tunnel - share the read-only public dashboard through Cloudflare or Tailscale without
# opening a port on your router. Installed to %ProgramFiles%\netBae; run it as `netbae tunnel ...`.
#
#   netbae tunnel                          choose interactively
#   netbae tunnel quick                    temporary https://<random>.trycloudflare.com address (no account)
#   netbae tunnel cloudflare <hostname>    permanent tunnel on your own domain, e.g. netbae.example.com
#   netbae tunnel cloudflare --token <t>   run a tunnel you created in the Cloudflare dashboard
#   netbae tunnel tailscale                Tailscale Funnel: https://<machine>.<tailnet>.ts.net
#   netbae tunnel status
#   netbae tunnel off                      stop sharing and turn the public dashboard off
$ErrorActionPreference = 'Stop'
$Command = ''; $Hostname = ''; $Token = ''
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = "$($args[$i])"
    if ($a -in '-token', '--token', '/token') { $Token = "$($args[$i + 1])"; $i++ }
    elseif ($a -like '--token=*') { $Token = $a.Substring(8) }
    elseif (-not $Command) { $Command = $a }
    else { $Hostname = $a }
}

$AppDir = Join-Path $env:ProgramFiles 'netBae'
$DataDir = Join-Path $env:ProgramData 'netBae'
$Conf = Join-Path $DataDir 'config.toml'
$CfDir = Join-Path $DataDir 'cloudflared'
$TaskName = 'netBae'
$TunnelTask = 'netBae tunnel'
$TunnelLog = Join-Path $DataDir 'netbae-tunnel.log'
$Py = if (Test-Path "$AppDir\python.txt") { (Get-Content "$AppDir\python.txt" -Raw).Trim() } else { 'python' }
$utf8 = New-Object Text.UTF8Encoding $false

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "xx $m" -ForegroundColor Red; exit 1 }

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $a = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" $Command $Hostname"
    if ($Token) { $a += " --token $Token" }
    $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
    exit $p.ExitCode
}
if (-not (Test-Path $Conf)) { Fail "netBae isn't installed here ($Conf not found)" }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------- config
function Get-ConfValue([string]$Section, [string]$Key) {
    $in = $false
    foreach ($line in [IO.File]::ReadAllLines($Conf)) {
        if ($line -match '^\[(.+)\]') { $in = ($Matches[1] -eq $Section); continue }
        if ($in -and $line -match "^$Key *= *`"?([^`"# ]*)") { return $Matches[1] }
    }
    ''
}
# Replace the key, add it to the end of its section, or add the section.
function Set-ConfValue([string]$Section, [string]$Key, [string]$Value) {
    $out = New-Object Collections.Generic.List[string]
    $in = $false; $seen = $false; $done = $false
    foreach ($line in [IO.File]::ReadAllLines($Conf)) {
        if ($line -match '^\[(.+)\]') {
            if ($in -and -not $done) { $out.Add("$Key = $Value"); $done = $true }
            $in = ($Matches[1] -eq $Section); if ($in) { $seen = $true }
        } elseif ($in -and -not $done -and $line -match "^$Key *=") {
            $c = $line.IndexOf('#')
            $out.Add("$Key = $Value" + $(if ($c -ge 0) { '   ' + $line.Substring($c) } else { '' })); $done = $true; continue
        }
        $out.Add($line)
    }
    if (-not $done) { if (-not $seen) { $out.Add(''); $out.Add("[$Section]") }; $out.Add("$Key = $Value") }
    [IO.File]::WriteAllText($Conf, (($out -join "`r`n") + "`r`n"), $utf8)
}
$PPort = Get-ConfValue 'public' 'port'; if (-not $PPort) { $PPort = '8080' }

function Restart-NetBae {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$AppDir\netbae.py*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-ScheduledTask -TaskName $TaskName
}
function Test-Public {
    try { (Invoke-WebRequest "http://127.0.0.1:$PPort/api/config" -UseBasicParsing -TimeoutSec 2).Content -like '*"public":true*' } catch { $false }
}
function Enable-Public {
    $before = [IO.File]::ReadAllText($Conf)
    Set-ConfValue 'public' 'enabled' 'true'
    Set-ConfValue 'public' 'host' '"127.0.0.1"'   # only the tunnel (on this machine) can reach it
    Set-ConfValue 'public' 'port' $PPort
    & $Py "$AppDir\netbae.py" -c $Conf --check-config | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "the config has errors - fix $Conf and re-run" }
    Info "Public dashboard: on, at http://127.0.0.1:$PPort (only reachable from this machine)"
    if (([IO.File]::ReadAllText($Conf) -ne $before) -or -not (Test-Public)) { Restart-NetBae }
    for ($i = 0; $i -lt 30; $i++) { if (Test-Public) { return }; Start-Sleep 1 }
    Fail "the public dashboard didn't come up on port $PPort - see: netbae logs"
}
function Disable-Public {
    Set-ConfValue 'public' 'enabled' 'false'
    Restart-NetBae
    Info 'Public dashboard: off'
}

# ---------------------------------------------------------------- cloudflared
function Find-Cloudflared {
    $c = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in "$AppDir\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") {
        if (Test-Path $p) { return $p }
    }
    $null
}
function Install-Cloudflared {
    $cf = Find-Cloudflared
    if ($cf) { return $cf }
    Info "Installing cloudflared (Cloudflare's tunnel program)"
    $dir = "$AppDir\cloudflared"
    New-Item -ItemType Directory -Force $dir | Out-Null
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" `
        -OutFile "$dir\cloudflared.exe" -UseBasicParsing
    Info "Installed $((& "$dir\cloudflared.exe" --version) | Select-Object -First 1)"
    "$dir\cloudflared.exe"
}
function New-CfDir {
    New-Item -ItemType Directory -Force $CfDir | Out-Null
    # only SYSTEM, Administrators and LOCAL SERVICE (which runs the tunnel) can read the credentials
    $null = & icacls.exe $CfDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' /Q
}
# "netBae tunnel": a boot-time scheduled task running cloudflared as LOCAL SERVICE, like netBae itself.
function Register-Tunnel([string]$Cf, [string]$CfArgs) {
    $action = New-ScheduledTaskAction -Execute $Cf -Argument "tunnel --no-autoupdate --logfile `"$TunnelLog`" $CfArgs" -WorkingDirectory $CfDir
    $triggers = @(
        (New-ScheduledTaskTrigger -AtStartup),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5))
    )
    $account = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-19').Translate([Security.Principal.NTAccount]).Value
    $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    if (-not (Test-Path $TunnelLog)) { New-Item -ItemType File $TunnelLog | Out-Null }
    $null = & icacls.exe $TunnelLog /grant '*S-1-5-19:M' /Q
    Stop-Tunnel
    Register-ScheduledTask -TaskName $TunnelTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
        -Description 'netBae public dashboard tunnel (Cloudflare)' -Force | Out-Null
    Start-ScheduledTask -TaskName $TunnelTask
}
function Stop-Tunnel {
    Stop-ScheduledTask -TaskName $TunnelTask -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$DataDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Test-TunnelRunning {
    [bool](Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$TunnelLog*" })
}
function Wait-Url([string]$Url) {
    Info "Waiting for $Url to answer (DNS can take a minute)"
    for ($i = 0; $i -lt 40; $i++) {
        try {
            if ((Invoke-WebRequest "$Url/api/config" -UseBasicParsing -TimeoutSec 5).Content -like '*"public":true*') {
                Write-Host ''; Info "Your public dashboard: $Url"; return
            }
        } catch { }
        Start-Sleep 3
    }
    Warn "no answer yet from $Url. It may still be setting up; check: netbae tunnel status"
}

function Invoke-Quick {
    $cf = Install-Cloudflared
    Enable-Public
    Write-Host ''
    Info 'Starting a temporary tunnel. Your address (https://....trycloudflare.com) appears in the box below.'
    Write-Host '    It changes every time this runs, and stops when you press Ctrl-C or close this window.'
    Write-Host '    The public dashboard stays on (only reachable from this PC) until: netbae tunnel off'
    Write-Host ''
    & $cf tunnel --no-autoupdate --url "http://127.0.0.1:$PPort"
}

function Invoke-Cloudflare {
    $cf = Install-Cloudflared
    New-CfDir
    if ($Token) {  # a tunnel set up in the Cloudflare dashboard
        [IO.File]::WriteAllText("$CfDir\token", $Token.Trim(), $utf8)
        Enable-Public
        Register-Tunnel $cf "run --token-file `"$CfDir\token`""
        Start-Sleep 8
        if (Test-TunnelRunning) {
            Info "Tunnel running. In the Cloudflare dashboard, give it a public hostname with service http://127.0.0.1:$PPort"
        } else {
            Warn "the tunnel isn't connecting - check the token. Log: $TunnelLog"
        }
        return
    }
    $h = $Hostname
    if (-not $h) { $h = Read-Host 'Hostname for the dashboard (on a domain in your Cloudflare account, e.g. netbae.example.com)' }
    $h = ($h -replace '^https?://', '') -replace '/.*$', ''
    if ($h -notlike '*.*') { Fail 'give a full hostname, e.g. netbae.example.com' }

    $cert = "$CfDir\cert.pem"
    if (-not (Test-Path $cert)) {
        Info "Sign in to Cloudflare: a browser opens; choose the domain for $h"
        $home2 = "$CfDir\.home"; Remove-Item $home2 -Recurse -Force -ErrorAction SilentlyContinue
        $oldHome, $oldProfile = $env:HOME, $env:USERPROFILE
        $env:HOME = $home2; $env:USERPROFILE = $home2
        try { & $cf tunnel login } finally { $env:HOME = $oldHome; $env:USERPROFILE = $oldProfile }
        $got = @("$home2\.cloudflared\cert.pem", "$env:USERPROFILE\.cloudflared\cert.pem") | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $got) { Fail "Cloudflare sign-in didn't finish (no cert.pem)" }
        Move-Item $got $cert -Force; Remove-Item $home2 -Recurse -Force -ErrorAction SilentlyContinue
    }
    $name = 'netbae-' + $env:COMPUTERNAME.ToLower()
    $creds = "$CfDir\credentials.json"
    $list = (& $cf tunnel --origincert $cert list -o json -n $name) | Out-String | ConvertFrom-Json
    $id = if ($list) { @($list)[0].id } else { $null }
    if ($id) {
        Info "Using your existing tunnel '$name'"
        & $cf tunnel --origincert $cert token --cred-file $creds $id | Out-Null
    } else {
        Info "Creating tunnel '$name'"
        & $cf tunnel --origincert $cert create --cred-file $creds $name | Out-Null
        $id = @((& $cf tunnel --origincert $cert list -o json -n $name) | Out-String | ConvertFrom-Json)[0].id
    }
    if (-not $id) { Fail "couldn't create the tunnel" }
    $route = & $cf tunnel --origincert $cert route dns $id $h 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        if ($route -match 'already' -and (Read-Host "A DNS record for $h already exists. Replace it? [y/N]") -match '^[yY]') {
            & $cf tunnel --origincert $cert route dns --overwrite-dns $id $h | Out-Null
        } else { Write-Host $route; Fail "couldn't point $h at the tunnel" }
    }
    $yml = @"
# Written by netbae tunnel. The tunnel only reaches netBae's read-only public port.
tunnel: $id
credentials-file: $creds
ingress:
  - hostname: $h
    service: http://127.0.0.1:$PPort
  - service: http_status:404
"@
    [IO.File]::WriteAllText("$CfDir\config.yml", $yml, $utf8)
    Enable-Public
    Register-Tunnel $cf "--config `"$CfDir\config.yml`" run"
    Wait-Url "https://$h"
    Write-Host "    Only invited people? Add a Cloudflare Access application for $h (free for up to 50 users)."
}

# ---------------------------------------------------------------- tailscale
function Find-Tailscale {
    $c = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = "$env:ProgramFiles\Tailscale\tailscale.exe"
    if (Test-Path $p) { $p } else { $null }
}
function Invoke-Tailscale {
    $ts = Find-Tailscale
    if (-not $ts) { Fail 'install Tailscale from https://tailscale.com/download/windows, sign in, then re-run: netbae tunnel tailscale' }
    & $ts status *> $null
    if ($LASTEXITCODE -ne 0) { Info 'Sign in to Tailscale: open the link below'; & $ts up }
    Enable-Public
    Info "Turning on Funnel for port $PPort (the first time, Tailscale may give you a link to allow Funnel)"
    & $ts funnel --bg $PPort
    $dns = try { ((& $ts status --json) | Out-String | ConvertFrom-Json).Self.DNSName.TrimEnd('.') } catch { $null }
    if ($dns) { Wait-Url "https://$dns" } else { & $ts funnel status }
}

# ---------------------------------------------------------------- status / off
function Show-Status {
    Write-Host "Public dashboard: $(Get-ConfValue 'public' 'enabled') (host $(Get-ConfValue 'public' 'host'), port $PPort)"
    if (Get-ScheduledTask -TaskName $TunnelTask -ErrorAction SilentlyContinue) {
        $how = if (Test-Path "$CfDir\token") { 'a Cloudflare dashboard tunnel' } else { 'your own domain' }
        Write-Host "Cloudflare Tunnel: $(if (Test-TunnelRunning) { 'running' } else { 'not running' }) ($how)"
        if (Test-Path "$CfDir\config.yml") {
            Get-Content "$CfDir\config.yml" | Where-Object { $_ -match '^  - hostname: (.+)' } | ForEach-Object { Write-Host "    https://$($Matches[1])" }
        }
    } else { Write-Host 'Cloudflare Tunnel: not set up' }
    $ts = Find-Tailscale
    if ($ts) { Write-Host 'Tailscale Funnel:'; & $ts funnel status 2>&1 | ForEach-Object { "    $_" } }
}
function Invoke-Off {
    if (Get-ScheduledTask -TaskName $TunnelTask -ErrorAction SilentlyContinue) {
        Stop-Tunnel
        Unregister-ScheduledTask -TaskName $TunnelTask -Confirm:$false
        Info "Cloudflare Tunnel stopped and removed (your login and tunnel are kept in $CfDir)"
    }
    $ts = Find-Tailscale
    if ($ts -and ((& $ts funnel status 2>$null) | Out-String) -like "*127.0.0.1:$PPort*") {
        & $ts funnel --https=443 off *> $null
        if ($LASTEXITCODE -ne 0) { & $ts funnel reset }
        Info 'Tailscale Funnel turned off'
    }
    Disable-Public
}

switch ($Command.ToLower()) {
    'quick' { Invoke-Quick }
    { $_ -in 'cloudflare', 'cf' } { Invoke-Cloudflare }
    { $_ -in 'tailscale', 'ts', 'funnel' } { Invoke-Tailscale }
    'status' { Show-Status }
    { $_ -in 'off', 'stop' } { Invoke-Off }
    '' {
        Write-Host @'
Share the read-only public dashboard without opening a port on your router:

  1) Quick look       temporary https://<random>.trycloudflare.com address, no account needed
  2) Your own domain  permanent https://netbae.example.com through a free Cloudflare Tunnel
  3) Tailscale        permanent https://<machine>.<tailnet>.ts.net through Tailscale Funnel

'@
        switch (Read-Host 'Choose 1, 2 or 3') {
            '1' { Invoke-Quick } '2' { Invoke-Cloudflare } '3' { Invoke-Tailscale } default { Fail 'nothing chosen' }
        }
    }
    default { Get-Content $PSCommandPath | Select-Object -Skip 1 -First 9 | ForEach-Object { $_ -replace '^# ?', '' }; exit 1 }
}
