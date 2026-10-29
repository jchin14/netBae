# netBae installer for Windows 10/11 (x64 or arm64) - runs netBae at boot as a scheduled task.
# install.sh is the Linux/macOS installer; Windows has no bash, so it gets this one.
# Re-running upgrades in place and keeps your config + data.
#
#   From GitHub (PowerShell as Administrator):
#     irm https://raw.githubusercontent.com/jchin14/netBae/main/install.ps1 | iex
#   From a checkout:
#     powershell -ExecutionPolicy Bypass -File install.ps1
#
# Environment overrides: NETBAE_REPO (owner/repo), NETBAE_REF (branch or tag),
# NETBAE_SRC (use this folder instead of downloading).
#
# Everything lives inside a function so that `irm | iex` never runs `exit` in your shell.

function Install-NetBae {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $Repo = if ($env:NETBAE_REPO) { $env:NETBAE_REPO } else { 'jchin14/netBae' }
    $Ref = if ($env:NETBAE_REF) { $env:NETBAE_REF } else { 'main' }
    $AppDir = Join-Path $env:ProgramFiles 'netBae'
    $DataDir = Join-Path $env:ProgramData 'netBae'
    $ConfFile = Join-Path $DataDir 'config.toml'
    $LogFile = Join-Path $DataDir 'netbae.log'
    $TaskName = 'netBae'
    $FirewallRule = 'netBae-dashboard'
    $SpeedtestVersion = '1.2.0'
    $PythonVersion = '3.12.10'
    $ChartJsUrl = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
    $AdapterUrl = 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js'
    $InstallUrl = "https://raw.githubusercontent.com/$Repo/$Ref/install.ps1"

    function Info($msg) { Write-Host '==> ' -ForegroundColor Blue -NoNewline; Write-Host $msg }
    function Warn($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }

    # Native commands: Windows PowerShell turns their stderr into errors under 'Stop', so relax it here.
    function Invoke-Native {
        $ErrorActionPreference = 'Continue'
        $exe = $args[0]
        $rest = @($args | Select-Object -Skip 1)   # an array even for one argument, so @rest splats it
        $out = & $exe @rest 2>&1 | ForEach-Object { "$_" }
        [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($out -join "`n") }
    }

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

    # ------------------------------------------------------------ elevation
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Info 'Administrator rights are needed - asking Windows for them'
        # Re-run this installer as admin from a plain script file in Temp that you can open and read (the same
        # installer, with the repo and branch you chose set at the top), rather than an encoded command line.
        $body = if ($PSCommandPath) { Get-Content -Raw $PSCommandPath } else { (Invoke-WebRequest -UseBasicParsing $InstallUrl).Content }
        $sets = @("`$env:NETBAE_REPO = '$Repo'", "`$env:NETBAE_REF = '$Ref'")
        if ($env:NETBAE_SRC) { $sets += "`$env:NETBAE_SRC = '$($env:NETBAE_SRC)'" }
        $file = Join-Path $env:TEMP 'netbae-install.ps1'
        Set-Content -Path $file -Encoding UTF8 -Value (($sets -join "`r`n") + "`r`n" + $body)
        Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy RemoteSigned -NoExit -File `"$file`""
        return
    }
    if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'netBae needs Windows 10 or 11' }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue

    function Install-Winget($id) {
        if (-not $winget) { return $false }
        Info "Installing $id with winget"
        $r = Invoke-Native $winget.Source install --id $id --exact --scope machine --silent `
            --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($r.Code -ne 0) { Warn "winget install $id failed (exit $($r.Code))" }
        return ($r.Code -eq 0)
    }

    # ------------------------------------------------------------ Python 3.11+ (for tomllib)
    function Find-Python {
        $cands = New-Object System.Collections.Generic.List[string]
        foreach ($n in 'python.exe', 'python3.exe') {
            Get-Command $n -All -ErrorAction SilentlyContinue | ForEach-Object { $cands.Add($_.Source) }
        }
        $py = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($py) {
            $r = Invoke-Native $py.Source -3 -c 'import sys; print(sys.executable)'
            if ($r.Code -eq 0) { $cands.Add($r.Output.Trim()) }
        }
        foreach ($glob in "$env:ProgramFiles\Python3*\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe") {
            Get-ChildItem $glob -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $cands.Add($_.FullName) }
        }
        foreach ($c in $cands) {
            if (-not $c -or $c -like '*\WindowsApps\*') { continue }  # the Microsoft Store stub
            # A venv's python.exe is a launcher that starts a second process; use the real one.
            $r = Invoke-Native $c -c "import sys; print(getattr(sys, '_base_executable', sys.executable)) if sys.version_info >= (3, 11) else sys.exit(1)"
            if ($r.Code -eq 0 -and $r.Output.Trim() -and (Test-Path $r.Output.Trim())) { return $r.Output.Trim() }
        }
        return $null
    }

    $Py = Find-Python
    if (-not $Py) {
        if (-not (Install-Winget 'Python.Python.3.12')) {
            $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
            $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-$arch.exe"
            $exe = Join-Path $env:TEMP "python-$PythonVersion-$arch.exe"
            Info "Installing Python $PythonVersion from python.org"
            Invoke-WebRequest -UseBasicParsing $url -OutFile $exe
            $p = Start-Process $exe -ArgumentList '/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_test=0' -Wait -PassThru
            Remove-Item $exe -Force -ErrorAction SilentlyContinue
            if ($p.ExitCode -ne 0) { throw "Python installer failed (exit $($p.ExitCode))" }
        }
        $Py = Find-Python
        if (-not $Py) { throw 'Python 3.11+ still not found - install it from https://www.python.org/downloads/windows/ and re-run' }
    }
    Info "Using $Py ($((Invoke-Native $Py --version).Output))"

    # ------------------------------------------------------------ source files
    $tmp = $null
    $Src = $env:NETBAE_SRC
    if (-not $Src -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'app\netbae.py'))) { $Src = $PSScriptRoot }
    if (-not $Src) {
        $tmp = Join-Path $env:TEMP ("netbae-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $tmp | Out-Null
        Info "Downloading netBae ($Repo@$Ref)"
        Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/archive/$Ref.zip" -OutFile "$tmp\src.zip"
        Expand-Archive "$tmp\src.zip" -DestinationPath $tmp
        $Src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    }
    if (-not (Test-Path (Join-Path $Src 'app\netbae.py'))) { throw "$Src does not contain app\netbae.py" }

    try {
        # ------------------------------------------------------------ stop the running copy
        function Stop-NetBae {
            if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
                Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            }
            Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -like "*$AppDir\netbae.py*" } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            # a speedtest it started keeps running on its own and would lock speedtest.exe
            Get-Process speedtest -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$AppDir\*" } |
                Stop-Process -Force -ErrorAction SilentlyContinue
        }
        Stop-NetBae

        # ------------------------------------------------------------ official Ookla speedtest CLI
        function Test-Ookla($exe) {
            if (-not $exe -or -not (Test-Path $exe)) { return $false }
            (Invoke-Native $exe --version).Output -match 'Ookla'
        }
        # Ookla installs other than netBae's own copy in $AppDir\speedtest
        function Find-Ookla {
            $c = @("$env:ProgramFiles\WinGet\Links\speedtest.exe")
            $c += Get-ChildItem "$env:ProgramFiles\WinGet\Packages\Ookla.Speedtest.CLI*\speedtest.exe" -ErrorAction SilentlyContinue | ForEach-Object FullName
            $c += Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Ookla.Speedtest.CLI*\speedtest.exe" -ErrorAction SilentlyContinue | ForEach-Object FullName
            $c += Get-Command speedtest.exe -All -ErrorAction SilentlyContinue | ForEach-Object Source
            foreach ($e in $c) { if ($e -notlike "$AppDir\*" -and (Test-Ookla $e)) { return $e } }
            return $null
        }
        function Install-OoklaZip {
            $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'x86') { 'win32' } else { 'win64' }  # arm64 runs win64 under emulation
            $url = "https://install.speedtest.net/app/cli/ookla-speedtest-$SpeedtestVersion-$arch.zip"
            Info "Installing Ookla speedtest CLI from the official release zip"
            $z = Join-Path $env:TEMP "ookla-speedtest.zip"
            try {
                Invoke-WebRequest -UseBasicParsing $url -OutFile $z
                New-Item -ItemType Directory -Force "$AppDir\speedtest" | Out-Null
                Expand-Archive $z -DestinationPath "$AppDir\speedtest" -Force
                return $true
            } catch {
                Warn "download failed: $url ($_)"
                return $false
            } finally {
                Remove-Item $z -Force -ErrorAction SilentlyContinue
            }
        }

        # netBae runs speedtest.exe from $AppDir\speedtest: LOCAL SERVICE can't start winget's copy
        # (WinGet\Links is a symlink into a folder only admins can read) or anything in a user profile.
        # So an existing or winget install is copied there, refreshed on every re-run.
        $Own = "$AppDir\speedtest\speedtest.exe"
        $St = Find-Ookla
        if ($St) {
            Info "Ookla speedtest CLI found: $St"
        } elseif (-not (Test-Ookla $Own) -and (Install-Winget 'Ookla.Speedtest.CLI')) {
            $St = Find-Ookla
        }
        if ($St) {
            New-Item -ItemType Directory -Force "$AppDir\speedtest" | Out-Null
            Copy-Item $St $Own -Force
        } elseif (-not (Test-Ookla $Own)) {
            $null = Install-OoklaZip
        }
        if (Test-Ookla $Own) {
            $St = $Own
            Info "Ookla speedtest CLI for netBae: $St"
        } else {
            $St = $null
            Warn 'Could not install the Ookla speedtest CLI - speedtests will show errors until it is installed'
        }

        # ------------------------------------------------------------ files
        $verRe = '(?m)^VERSION = "(.*)"'
        $Old = $null
        if ((Test-Path "$AppDir\netbae.py") -and ((Get-Content "$AppDir\netbae.py" -Raw) -match $verRe)) { $Old = $Matches[1] }
        $null = (Get-Content "$Src\app\netbae.py" -Raw) -match $verRe
        $New = $Matches[1]
        if ($Old) { Info "Updating netBae $Old -> $New (config and data are kept)" } else { Info "Installing netBae $New to $AppDir" }

        New-Item -ItemType Directory -Force $AppDir, $DataDir, "$AppDir\bin" | Out-Null
        $vendorBackup = $null
        if (Test-Path "$AppDir\static\vendor") {
            $vendorBackup = Join-Path $env:TEMP ("netbae-vendor-" + [guid]::NewGuid().ToString('N'))
            Copy-Item "$AppDir\static\vendor" $vendorBackup -Recurse
        }
        Remove-Item "$AppDir\static" -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item "$Src\app\*" $AppDir -Recurse -Force -Exclude '__pycache__'
        Copy-Item "$Src\uninstall.ps1" $AppDir -Force
        Copy-Item "$Src\tunnel.ps1" $AppDir -Force
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $mgr = [IO.File]::ReadAllText("$Src\bin\netbae.ps1", $utf8).Replace('__NETBAE_REPO__', $Repo)
        [IO.File]::WriteAllText("$AppDir\bin\netbae.ps1", $mgr, $utf8)
        Copy-Item "$Src\bin\netbae.cmd" "$AppDir\bin\netbae.cmd" -Force
        # clear any "downloaded from the internet" mark so the RemoteSigned policy runs netBae's own scripts
        Get-ChildItem $AppDir -Recurse -File -Include *.ps1, *.cmd | Unblock-File
        [IO.File]::WriteAllText("$AppDir\python.txt", $Py, $utf8)
        New-Item -ItemType Directory -Force "$AppDir\static\vendor" | Out-Null
        if ($vendorBackup) {
            Copy-Item "$vendorBackup\*" "$AppDir\static\vendor" -Force
            Remove-Item $vendorBackup -Recurse -Force
        }

        # Chart.js is served from the machine itself so the dashboard still works when the internet is down.
        Info 'Downloading Chart.js for offline use'
        $pins = @{ $ChartJsUrl = 'd2af8974e95271638772e9e9524db5b9a6f58d6ec2d5d781400447b4a31c681e'; $AdapterUrl = 'ea7ab30d26c38dcf1f2d26bb43e73a94537b58f1906f55e1a546dd09321b5615' }   # a download that doesn't match is thrown away
        foreach ($u in $ChartJsUrl, $AdapterUrl) {
            $dest = Join-Path "$AppDir\static\vendor" ($u -split '/')[-1]
            try {
                Invoke-WebRequest -UseBasicParsing $u -OutFile "$dest.new"
                if ((Get-FileHash "$dest.new" -Algorithm SHA256).Hash -ne $pins[$u]) { throw 'checksum mismatch' }
                Move-Item "$dest.new" $dest -Force
            } catch {
                Remove-Item "$dest.new" -Force -ErrorAction SilentlyContinue
                Warn "$(Split-Path $dest -Leaf) download failed - browsers will fall back to the CDN"
            }
        }

        # `netbae` command on the machine PATH
        $binDir = "$AppDir\bin"
        Set-MachinePath { param($parts) if ($parts -contains $binDir) { $parts } else { @($parts) + $binDir } }
        if (($env:Path -split ';') -notcontains $binDir) { $env:Path = $env:Path.TrimEnd(';') + ";$binDir" }

        # The shipped config uses the Linux database path; point it at %ProgramData%\netBae.
        $default = [IO.File]::ReadAllText("$Src\config.toml", $utf8).Replace('/var/lib/netbae/', ($DataDir -replace '\\', '/') + '/')
        $freshConfig = -not (Test-Path $ConfFile)
        if (-not $freshConfig) {
            Info "Keeping existing $ConfFile (new defaults saved as config.toml.default)"
            [IO.File]::WriteAllText("$ConfFile.default", $default, $utf8)
        } else {
            [IO.File]::WriteAllText($ConfFile, $default, $utf8)
        }

        # netBae runs as the built-in LOCAL SERVICE account (S-1-5-19), which only needs to write its data folder.
        # A Python installed inside someone's user profile is not readable by it, so fall back to SYSTEM then.
        $SvcSid = if ($Py -like "$env:SystemDrive\Users\*") { 'S-1-5-18' } else { 'S-1-5-19' }
        $null = Invoke-Native icacls.exe $DataDir /grant "*S-1-5-19:(OI)(CI)M" /T /Q
        $SvcAccount = (New-Object Security.Principal.SecurityIdentifier $SvcSid).Translate([Security.Principal.NTAccount]).Value

        $r = Invoke-Native $Py "$AppDir\netbae.py" -c $ConfFile --check-config
        if ($r.Code -ne 0) { Write-Host $r.Output; throw "config check failed - fix $ConfFile and re-run" }
        $Port = [int](Invoke-Native $Py "$AppDir\netbae.py" -c $ConfFile --print-port).Output.Trim()
        $Boot = (Invoke-Native $Py "$AppDir\netbae.py" -c $ConfFile --print-start-at-boot).Output.Trim() -ne 'false'

        # ------------------------------------------------------------ port check
        function Get-PortHolder($p) { Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1 }
        $holder = Get-PortHolder $Port
        # Port 80 is often taken on Windows (IIS / http.sys): move to the next free port and save it in the config.
        if ($holder) {
            $name = (Get-Process -Id $holder.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            if ($holder.OwningProcess -eq 4) { $name = 'System (http.sys: IIS, WinRM, or another web service)' }
            $alt = ($Port + 1)..($Port + 19) | Where-Object { -not (Get-PortHolder $_) } | Select-Object -First 1
            if (-not $alt) { throw "port $Port and the 19 after it are all in use. Set a free [web] port in $ConfFile and re-run." }
            Warn "port $Port is used by '$name' - using port $alt instead (saved as [web] port in $ConfFile)"
            $text = [IO.File]::ReadAllText($ConfFile, $utf8) -replace '(?ms)(^\[web\][ \t]*\r?$(?:(?!^\[).)*?^port *= *)\d+', "`${1}$alt"  # [web] only, not [public]
            [IO.File]::WriteAllText($ConfFile, $text, $utf8)
            $Port = $alt
        }

        # ------------------------------------------------------------ scheduled task
        # A real Windows service needs pywin32 or a wrapper exe; a boot-time task needs nothing extra.
        # Task Scheduler only restarts a task that fails to launch, so a 5-minute repeating trigger
        # brings netBae back if it ever exits (IgnoreNew makes it a no-op while it's running).
        Info "Installing scheduled task '$TaskName' ($(if ($Boot) { 'runs at boot' } else { 'start_at_boot is off' }) as $SvcAccount)"
        $taskArgs = "`"$AppDir\netbae.py`" -c `"$ConfFile`" --log-file `"$LogFile`""
        $action = New-ScheduledTaskAction -Execute $Py -Argument $taskArgs -WorkingDirectory $DataDir
        # [web] start_at_boot = false: the same triggers, turned off, so netBae only runs after netbae start
        # (a past one-off trigger could still fire through StartWhenAvailable). netbae.ps1 switches these too.
        $triggers = @(
            (New-ScheduledTaskTrigger -AtStartup),
            (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5))
        )
        if (-not $Boot) { $triggers | ForEach-Object { $_.Enabled = $false } }
        $principal = New-ScheduledTaskPrincipal -UserId $SvcAccount -LogonType ServiceAccount -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -MultipleInstances IgnoreNew -Priority 5
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
            -Description 'netBae internet connection monitor (https://github.com/jchin14/netBae)' -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName

        # The dashboard's Update button: a SYSTEM task that runs `netbae update`, which netBae's own account
        # (LOCAL SERVICE) is allowed to start but not change. The service itself never gets admin rights.
        $upArgs = "-NoProfile -ExecutionPolicy RemoteSigned -Command `"& '$AppDir\bin\netbae.ps1' update *>&1 | Out-File -Encoding utf8 '$DataDir\update.log'`""
        $upAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $upArgs -WorkingDirectory $DataDir
        $upPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $upSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName 'netBae update' -Action $upAction -Principal $upPrincipal -Settings $upSettings `
            -Description "Updates netBae when you press Update on its dashboard" -Force | Out-Null
        try {
            $ts = New-Object -ComObject Schedule.Service
            $ts.Connect()
            $t = $ts.GetFolder('\').GetTask('netBae update')
            $sddl = $t.GetSecurityDescriptor(4)   # the access list
            if ($sddl -notlike '*;;;LS)*') { $t.SetSecurityDescriptor($sddl + '(A;;GRGX;;;LS)', 0) }  # LOCAL SERVICE: read + run
        } catch { Warn "The dashboard's Update button won't work: couldn't let netBae start its update task ($_)" }

        # Windows Firewall: allow the dashboard from the local network only.
        Remove-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue
        New-NetFirewallRule -Name $FirewallRule -DisplayName "netBae dashboard (TCP $Port)" -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any | Out-Null
        Info "Allowed TCP port $Port from the local network in Windows Firewall"

        $up = $false
        foreach ($i in 1..30) {
            Start-Sleep -Seconds 1
            try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" -TimeoutSec 3 | Out-Null; $up = $true; break } catch { }
        }
        if (-not $up) {
            if (Test-Path $LogFile) { Get-Content $LogFile -Tail 30 }
            throw "netBae failed to start (see $LogFile)"
        }
        # This PC's address on the default route, for the dashboard link. Not Get-NetIPConfiguration: it throws
        # ("Exception setting NetAdapter") on machines where an adapter matches more than once.
        $ip = $null
        try {
            $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
            $ip = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
                Select-Object -First 1 -ExpandProperty IPAddress
        } catch { }
        if (-not $ip) { $ip = '<this-pc-ip>' }
        $suffix = if ($Port -eq 80) { '' } else { ":$Port" }
        Write-Host ''
        if ($Old) { Info "netBae updated to $New and running!" } else { Info 'netBae is running!' }
        Write-Host "    Dashboard:  http://$ip$suffix"
        Write-Host "                http://$($env:COMPUTERNAME.ToLower())$suffix"
        Write-Host "    Config:     netbae config     ($ConfFile)"
        Write-Host "    Logs:       netbae logs       ($LogFile)"
        Write-Host '    Update:     netbae update     (or re-run the install command)'
        Write-Host '    Share:      netbae tunnel     (a read-only dashboard anyone can open, no port forwarding)'
        Write-Host '    (open a new terminal for the netbae command)'
        if (-not $St) { Warn 'Ookla speedtest CLI is missing - see https://www.speedtest.net/apps/cli' }
    } finally {
        if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Install-NetBae
} catch {
    Write-Host "xx $_" -ForegroundColor Red
    if ($PSCommandPath) { exit 1 }   # run as a file: fail the process; piped into iex: leave the shell open
}
