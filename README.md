<div align="center">

# netBae

<sub>by <a href="https://github.com/jchin14">jchin14</a></sub>

**A self-hosted dashboard for your home internet connection.**<br>
Ping, DNS, game servers and speedtests, recorded around the clock on a Raspberry Pi, a Linux VM, a Mac or a Windows PC.

![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows%20%7C%20Docker-2f6fe4)
![Python](https://img.shields.io/badge/python-3.8%2B-2f6fe4)
![Dependencies](https://img.shields.io/badge/dependencies-none-1a9e5c)
![License](https://img.shields.io/badge/license-personal%20use-d48806)
[![Buy me a coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-jchin14-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/jchin14)

<img src="docs/screenshot.png" alt="netBae dashboard" width="900">

</div>

## TL;DR

**Install** (or update: run it again, your config and history are kept):

Raspberry Pi, any Linux, or a Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/jchin14/netBae/main/install.sh | sudo bash
```

Windows 10/11, in PowerShell as Administrator:

```powershell
irm https://raw.githubusercontent.com/jchin14/netBae/main/install.ps1 | iex
```

Docker on a Linux host (set `TZ` to your timezone; the config and history go in a `netbae-data` folder where you run it):

```bash
docker run -d --name netbae --network host --restart unless-stopped \
  -e TZ=Australia/Melbourne -v "$PWD/netbae-data:/data" ghcr.io/jchin14/netbae:latest
```

Or Docker Compose: download [docker-compose.yml](docker-compose.yml) into an empty folder, set `TZ` in it, then start it:

```bash
curl -fsSLO https://raw.githubusercontent.com/jchin14/netBae/main/docker-compose.yml
docker compose up -d
```

**Open** `http://<that-machine>/` from any device on your network. If port 80 was taken, the installer picks the next free one (81, 82 …) and prints the address, e.g. `http://<that-machine>:81/`; `netbae status` shows it too.

**Useful commands:**

| Command | What it does |
|---|---|
| `netbae status` | is it running, and on which port? |
| `netbae logs` | follow the log |
| `netbae config` | edit the config, check it and restart |
| `netbae check` | check the config and show when the next speedtests run |
| `netbae update` | update to the latest version |
| `netbae restart` | restart it (also: `start`, `stop`) |
| `netbae tunnel` | share a read-only dashboard publicly (no port forwarding) |
| `netbae tunnel status` | what's shared, where, and how many visitors (also: `off`) |
| `netbae export` | save the whole history to one file, e.g. to move it to another machine |
| `netbae import <file>` | replace this machine's history with an export |
| `netbae uninstall` | remove it (`--purge` also deletes config and history; `-Purge` on Windows) |

## Contents

- [Why netBae](#why-netbae)
- [Install](#install): supported systems, what the installer does on Linux, macOS and Windows, Docker, where things live
- [Everyday use](#everyday-use): [Moving to another machine](#moving-to-another-machine) · [Uninstall](#uninstall)
- [Configuration](#configuration): [All options](#all-options) · [Game servers](#game-servers) · [Regions](#region-speedtests-and-pings) · [Secondary connection](#monitoring-a-secondary-connection)
- [Sharing a public dashboard](#sharing-a-public-dashboard): [netbae tunnel](#the-easy-way-netbae-tunnel) · [With Docker](#with-docker) · [What visitors see](#what-visitors-see) · [Signing in](#signing-in-to-your-own-dashboard) · [By hand](#by-hand)
- [How it measures](#how-it-measures)
- [Averages and storage](#averages-and-storage)
- [Behind a reverse proxy](#behind-a-reverse-proxy) · [API](#api) · [FAQ](#faq) · [How it's tested](#how-its-tested) · [Contributing](#contributing) · [Support](#support) · [Licence](#licence)

## Why netBae

Your ISP's status page says everything is fine, but your game lagged, the video call dropped and the evening stream buffered. netBae keeps a record of what your connection was actually doing, so you can see when it was slow, how slow and where the problem was.

| | |
|---|---|
| **Ping, every 30 seconds** | your router and your ISP's first hop (BNG), DNS resolvers, Google/YouTube, streaming (Netflix, Twitch, Disney+, HBO Max, Paramount+, plus Stan, ABC iview, SBS On Demand, 7plus, 9Now, 10, Foxtel, Kayo and Sky News in Australia), Facebook/Instagram/Reddit/X/TikTok, AI (ChatGPT, Claude, Grok), calls and chat (Slack, Teams, Zoom, Webex, Meet), Microsoft/Apple/AWS/GitHub/Atlassian, hosting data centres (AWS, Oracle Cloud, Azure, OVHcloud, Vultr, DigitalOcean, Linode, Hetzner), CDNs (Akamai, Fastly, Cloudflare, CloudFront, Azure Front Door, Bunny, Gcore), Chinese clouds and CDNs (Alibaba, Tencent, Huawei, Baidu, ByteDance, CDNetworks), Usenet in the US and Europe, and **game servers** (Steam & CS2, Fortnite, Discord voice, AWS GameLift, Battle.net, Minecraft) |
| **Grouped overview** | one card per category with its average ping; click a card to see every host in it |
| **Charts that show jitter** | the average as a line with a shaded P5-P95 (or min-max) band; zoom and drag the y-axis |
| **Speedtests** | the official [Ookla Speedtest CLI](https://www.speedtest.net/apps/cli): download, upload, ping, jitter, packet loss, ISP and data used, with 24-hour and 7-day averages. Pings, DNS checks and traceroutes pause while a test runs, so neither skews the other |
| **Worldwide view** | latency to 19 cities (London, New York, Tokyo, Singapore …), plus optional speedtests to them |
| **Which ISP you're on** | each connection's public IP and ISP, checked every 10 minutes and marked on the System history chart, so failovers stand out |
| **Routes** | every 12 hours, the route to each target: **on-net**, **direct**, via an **IX** (named) or **transit** through carriers like Cogent, Arelion or GTT, with each hand-over labelled **peering** or **paid transit** |
| **Secondary connection** | test a second internet connection (e.g. a 5G failover link) alongside your main one |
| **IPv4 and IPv6** | sites pinged and traced over both when your network has IPv6, side by side on the tiles and charts |
| **DNS over IPv4 and IPv6** | your router (IPv4 and IPv6), the DNS servers DHCP gave you when they aren't the router, and Cloudflare, Google, Quad9 (with and without ECS), OpenDNS, CleanBrowsing, AdGuard, NextDNS and Control D |
| **Which DNS gets you the closest CDN** | every resolver looks up Akamai test names, google.com, microsoft.com and www.cloudflare.com; the addresses each one hands out are pinged and traced, and the resolvers are ranked by average latency |
| **Public dashboard** | optionally share a read-only, privacy-masked copy through Cloudflare or Tailscale with one command |
| **History forever** | every ping for 7 days, 1-minute summaries for 90 days, hourly summaries for ever |
| **Light and dark themes** | follows your device, or pick one in the header |
| **No dependencies** | Python's standard library and SQLite; works from any device on your network, even when the internet is down |

## Install

The [TL;DR](#tldr) has the install commands. Run the same command again any time to update; your config and history are kept. On a Linux or Mac machine that can't run `curl` against GitHub, download `netbae-<version>.tar.gz` from the [latest release](https://github.com/jchin14/netBae/releases/latest), copy it across and run `tar -xzf netbae-<version>.tar.gz && cd netbae-<version> && sudo bash install.sh`. It works on:

| | Supported |
|---|---|
| **Linux** | Raspberry Pi OS, Debian, Ubuntu, Fedora, RHEL/Rocky/Alma, Arch, openSUSE (systemd) on x86_64, arm64, armhf, armv6, i386 |
| **macOS** | 12 Monterey or later, Apple silicon or Intel (uses Homebrew) |
| **Windows** | 10 and 11 (and Server 2019+), x64 or arm64, with its own PowerShell installer (`install.ps1`) |
| **Docker** | Linux hosts (Pi, NAS, Proxmox, servers) on amd64, arm64 and arm/v7, with host networking |
| **NixOS** | a flake with a package and a `services.netbae` module, on x86_64 and arm64 (see [NixOS](#nixos) below) |

<details>
<summary><b>What the installer does on Linux</b></summary>

1. installs `python3`, `ping` and `curl` with your package manager
2. installs the official Ookla Speedtest CLI from Ookla's package repository (Debian/Ubuntu/Pi OS, Fedora/RHEL), so it updates with your system, or from Ookla's release tarball elsewhere. The unofficial Python `speedtest-cli` is removed, since it conflicts.
3. creates an unprivileged `netbae` user and installs the app to `/opt/netbae`
4. writes `/etc/netbae/config.toml` (an existing config is never overwritten)
5. starts the `netbae` systemd service on port 80 without running as root (via `CAP_NET_BIND_SERVICE`). If something else already uses the port, it takes the next free one (81, 82 …), saves it in the config and tells you
6. opens the port in `ufw`/`firewalld` if either is active, and installs the `netbae` command

On Proxmox, use a VM or a *privileged* LXC container; unprivileged LXC can block ping.
</details>

<details>
<summary><b>What the installer does on macOS</b></summary>

Install [Homebrew](https://brew.sh) first, then run the install command from the [TL;DR](#tldr) in Terminal and enter your Mac password when `sudo` asks. The dashboard is at `http://<your-mac>.local/` (the installer prints the exact address). The installer:

1. uses (or `brew install`s) a Python 3.11+; macOS's own `python3` is too old
2. installs the Ookla CLI from Ookla's Homebrew tap (`teamookla/speedtest`). Homebrew always runs as your user, never as root.
3. creates a hidden `_netbae` user and installs the app to `/usr/local/lib/netbae`
4. writes `/usr/local/etc/netbae/config.toml`
5. starts a launchd LaunchDaemon (`com.github.netbae`) on port 80 (or the next free port, saved in the config), so it runs from boot with nobody logged in, still as an unprivileged user
6. allows Python through the macOS firewall if it's on

Tips: stop the Mac from sleeping (System Settings → Energy), and use Ethernet so the charts measure your internet rather than your Wi-Fi. If you turn the macOS firewall on later, re-run the install command so other devices can still reach the dashboard. Temperature isn't available on macOS without root. `netbae uninstall` leaves the speedtest CLI installed; `brew uninstall speedtest` removes it.
</details>

<details>
<summary><b>What the installer does on Windows</b></summary>

`install.sh` is a bash script built around systemd and launchd, and a stock Windows has neither, so Windows gets `install.ps1`, written for the Windows PowerShell that every Windows 10/11 already has. From a clone, run `powershell -ExecutionPolicy Bypass -File install.ps1`; from a non-admin window it asks for admin rights (UAC) and continues in a new window. It:

1. uses an installed Python 3.11+, or installs Python 3.12 with `winget` (or the python.org installer if winget is missing)
2. installs the official Ookla CLI with `winget` (`Ookla.Speedtest.CLI`) or from Ookla's zip, and keeps a copy in `C:\Program Files\netBae\speedtest` that the service account can run
3. installs the app to `C:\Program Files\netBae` and puts the `netbae` command on the PATH (works in cmd and PowerShell)
4. writes `C:\ProgramData\netBae\config.toml` (an existing config is never overwritten)
5. registers a scheduled task (`netBae`) that starts at boot with nobody logged in, as the unprivileged built-in *LOCAL SERVICE* account, and comes back within 5 minutes if it ever stops. A real Windows service would need pywin32 or a wrapper exe; a task needs nothing extra.
6. allows the port in Windows Firewall from your local network only. Port 80 is often taken on Windows (IIS, http.sys); the installer then moves to the next free port (81, 82 …), saves it in the config and tells you.

`netbae uninstall -Purge` removes everything, including the task, firewall rule and PATH entry; Python and a winget-installed speedtest CLI are left alone.

Tips: turn off sleep (Settings → System → Power). Load average and temperature aren't available on Windows; CPU, RAM, page file, storage and uptime are. For a [secondary connection](#monitoring-a-secondary-connection), `bind` must be an IP address (Windows `ping` can't pick an interface by name).

**WSL2?** You could run the Linux installer inside WSL2, but it makes a poor monitor: WSL2 sits behind its own NAT, so `gateway` is the WSL virtual switch rather than your router and every ping has an extra hop; other devices can't reach the dashboard without port forwarding or mirrored networking; and WSL only runs while something keeps it alive. Use the native installer instead.
</details>

<details>
<summary><b>Running it with Docker</b></summary>

Use the `docker run` command above, or [docker-compose.yml](docker-compose.yml): download it into an empty folder, set `TZ` in it, then start it with `docker compose up -d`.

```bash
curl -fsSLO https://raw.githubusercontent.com/jchin14/netBae/main/docker-compose.yml
```

Images: `ghcr.io/jchin14/netbae` for amd64, arm64 (Pi 3/4/5 on 64-bit) and arm/v7 (32-bit Pi OS).

- **Use host networking** (`network_mode: host` / `--network host`). In Docker's default bridge network every test goes through Docker's NAT, so "Router" would be Docker's gateway, routes would start inside Docker, DHCP DNS would show Docker's resolver, and secondary connections couldn't bind to the host's IPs. netBae detects this and shows a warning on the dashboard.
- **Set `TZ`** to your timezone: speedtest times and offsets follow it.
- **Config and history:** `/data` in the container is the `netbae-data` folder on the host (with the commands above). It holds `config.toml`, created from the defaults on first start, and the history database. To change settings, edit `netbae-data/config.toml` on the host (it's owned by root, so use `sudo nano netbae-data/config.toml` or similar) and run `docker restart netbae` (or `docker compose restart`); no need to open a shell in the container. `config.toml.default` next to it always has the latest defaults and comments. Back up the folder to keep your history.
- **Disk usage:** add `-v /:/host:ro` to show the host's disk instead of the container's.
- **Port:** host networking uses port 80 on the host; set `-e NETBAE_PORT=8080` before the first start (or change `[web] port` in `/data/config.toml`) if something else uses 80.
- **Update:** `docker pull ghcr.io/jchin14/netbae:latest` and recreate the container (`docker compose pull && docker compose up -d`).
- **Docker Desktop on Mac/Windows** runs containers in a hidden VM, so host networking there means the VM's network. It works, but the native installers above measure your connection more accurately.
</details>

<details>
<summary><b>NixOS</b></summary>

<a id="nixos"></a>**The quick way:** the same install command as on any Linux system. On NixOS it adds netBae as a module instead of installing packages: it copies netBae to `/etc/nixos/netbae/`, writes `/etc/nixos/netbae.nix` (which turns the service on and opens its port), adds `./netbae.nix` to the `imports` in your `configuration.nix` (keeping a backup), and runs `nixos-rebuild switch`. Your settings stay in `/etc/netbae/config.toml`, and every `netbae` command works as on other systems (`netbae update` re-runs the installer). If the rebuild fails, your configuration is put back as it was. If `/etc/nixos` is a git repository (as flakes need), the new files are staged for you to commit.

**With your own flake:** add netBae as an input and turn the service on:

```nix
{
  inputs.netbae.url = "github:jchin14/netBae";
  inputs.netbae.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, netbae, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        netbae.nixosModules.default
        {
          services.netbae = {
            enable = true;
            openFirewall = true;   # reach the dashboard from other devices
            # port = 8080;         # default 80
            settings = {           # anything from config.toml, as Nix
              speedtest.interval_minutes = 120;
              ping.extra_targets = [ { name = "My server"; host = "example.com"; group = "Mine"; } ];
              ping.disable = [ "Streaming AU" ];
            };
          };
        }
        # ... your other modules
      ];
    };
  };
}
```

Then `sudo nixos-rebuild switch`, and open `http://<this-machine>/`.

- **Commands:** `netbae status`, `logs`, `restart`, `check`, `version` and `config` work either way. With settings in Nix, `netbae config` tells you to change them there; `netbae update` runs `nix flake update netbae` and `nixos-rebuild switch` when `/etc/nixos/flake.nix` has a `netbae` input. After the install command, `netbae tunnel` works too (see Tunnel below).
- **Tunnel:** with the install command, `netbae tunnel` works as on other systems, but turns the tunnel on through your NixOS configuration: it writes `/etc/nixos/netbae-tunnel.nix` (imported by `netbae.nix`) and runs `nixos-rebuild switch`. `cloudflared` comes from nixpkgs. With your own flake, set it in Nix (each one also turns on the public dashboard, on `127.0.0.1:8080`):
  ```nix
  services.netbae.tunnel.tailscale = true;      # then once: sudo tailscale up; sudo tailscale funnel --bg 8080
  services.netbae.tunnel.cloudflare = {         # a tunnel made in the Cloudflare dashboard,
    enable = true;                              # with public hostname -> http://127.0.0.1:8080
    tokenFile = "/etc/netbae/cloudflared/token";  # or configFile + credentialsFile for your own config.yml
  };
  ```
  Secret files stay outside the Nix store: systemd hands them to `netbae-tunnel.service`, which runs as its own unprivileged user.
- **Service:** `netbae.service` runs as its own unprivileged user (`DynamicUser`) with only the network capabilities it needs (`CAP_NET_RAW` for ping, `CAP_NET_BIND_SERVICE` for port 80), and keeps its history in `/var/lib/netbae` (really `/var/lib/private/netbae`).
- **Config:** `settings` becomes netBae's `config.toml`; anything you leave out keeps netBae's default. To edit a file instead, set `services.netbae.configFile = "/etc/netbae/config.toml";` (with `[storage] database` under `/var/lib/netbae` and `[web] auto_update = "off"`), as the installer does.
- **Licences:** netBae's licence (free for personal use) and the Ookla Speedtest CLI's aren't free software in Nix's sense. The module builds just those two from a package set that allows them, so you don't need `allowUnfree`. Set `services.netbae.speedtestPackage = null;` to run without speedtests.
- **Updates:** netBae never updates itself on NixOS: the dashboard shows when a new release is out, and `netbae update` (or `nix flake update netbae` and `nixos-rebuild switch`) installs it.
- **Uninstall:** `netbae uninstall [--purge]` undoes what the installer did and rebuilds. With your own flake, remove `services.netbae` and the input instead.
- **Without NixOS:** `nix run github:jchin14/netBae -- -c ./config.toml` runs it in the foreground (with a config whose `[storage] database` is somewhere you can write). Ping needs `CAP_NET_RAW`, so run it as root or use your system's capability-wrapped `ping`.
</details>

<details>
<summary><b>Where things live</b></summary>

| | Linux | macOS | Windows |
|---|---|---|---|
| App | `/opt/netbae` | `/usr/local/lib/netbae` | `C:\Program Files\netBae` |
| Config | `/etc/netbae/config.toml` | `/usr/local/etc/netbae/config.toml` | `C:\ProgramData\netBae\config.toml` |
| Database | `/var/lib/netbae/netbae.db` | `/usr/local/var/netbae/netbae.db` | `C:\ProgramData\netBae\netbae.db` |
| Log | `journalctl -u netbae` | `/usr/local/var/log/netbae.log` | `C:\ProgramData\netBae\netbae.log` |
| Service | systemd `netbae.service` | launchd `com.github.netbae` | scheduled task `netBae` |
</details>

## Everyday use

The `netbae` command does everything day to day; the full list is in the [TL;DR](#tldr) and `netbae help`. On Windows it works in cmd and PowerShell, and commands that change something (update, restart, config, tunnel, export, import, uninstall) ask for admin rights. Updates never overwrite your config. When a new version is out, the private dashboard shows an **Update to vX** button in the header: it runs the same update as `netbae update` and reloads the page once the new version is running. Clicking the version number checks for a new release right away: if there is one it asks whether to install it, otherwise it opens the release notes for your version. The dashboard itself has no admin rights; the button asks a small system job the installer sets up (a systemd path unit on Linux, a launchd job on a Mac, a SYSTEM scheduled task on Windows), which only runs the official update. netBae also updates itself automatically, by default at most once a week at 3:30 am when a new release is out. `[web] auto_update` and `auto_update_time` change that: daily, weekly, as soon as a release is found, or never, at the time of day you pick. In Docker the header shows the new version with the `docker compose pull` command instead.

The ping chart draws one line per category (the average of its hosts) and the DNS chart one line per resolver (IPv4 and IPv6 together). In the table under a chart, click a category to expand it into its hosts or addresses, and click a host to hide or show its line; hovering a row picks out its line. The DNS table also shows the route to each public resolver. In the chip list above a chart, the arrow opens a category, its name hides or shows it, and the rest of the row picks out its line (tap again to stop), which works with a finger on a phone too. Click a speedtest table's column headings to sort it by speed, ping, time and so on. On the dashboard, each chart's time menu has the last 15 minutes to a year, **A day…** (pick a date, then step with ◀ ▶) and a custom range. A badge shows whether a chart is **Live** or showing past data, and the header says when any chart isn't live. Once your connection has been on more than one ISP, the ping and DNS charts get an **ISP** selector that keeps only the times you were on that ISP, so you can compare providers.

### Moving to another machine

All of netBae's history (ping, DNS, speedtests, routes, system stats) is one database, so moving it is two commands. On the old machine (it keeps running while it saves):

```bash
netbae export                      # writes netbae-<hostname>-<date>.db here; or: netbae export ~/backup.db
```

Copy that file to the new machine (e.g. with `scp`), install netBae there, then:

```bash
netbae import netbae-oldpi-2026-10-30.db
```

Import asks before it replaces the new machine's history, stops netBae, puts the export in place and starts netBae again. The history it replaced is kept next to the database as `netbae.db.before-import`. Install the same or a newer netBae on the new machine: a newer one upgrades an older export by itself. Copy `config.toml` across too if you want the same hosts and settings. Histories can't be merged: the import replaces what's there. `netbae export` is also a simple backup.

Docker: `docker exec netbae python3 /opt/netbae/netbae.py --export /data/export.db` saves it to `netbae-data/export.db`. To import, run `docker compose stop netbae`, put the export in `netbae-data/` and run `docker compose run --rm --no-deps netbae --import /data/export.db`, then `docker compose start netbae`.

### Uninstall

Linux, macOS or Windows. This keeps your config and history, so a later reinstall carries on where it left off:

```bash
netbae uninstall
```

To delete everything, including the config, history and the service user:

```bash
netbae uninstall --purge
```

On Windows the flag is `-Purge` (`netbae uninstall -Purge`). If the `netbae` command is missing, run the uninstaller directly: `sudo bash /opt/netbae/uninstall.sh` on Linux, `sudo bash /usr/local/lib/netbae/uninstall.sh` on a Mac. The Ookla speedtest CLI is left installed (`brew uninstall speedtest` on a Mac).

Docker: remove the container, then delete the `netbae-data` folder if you don't want the config and history:

```bash
docker rm -f netbae
```

With Docker Compose, run `docker compose down` in the folder with `docker-compose.yml`.

## Configuration

Everything lives in one commented [config file](config.toml) (`netbae config` opens it, checks it and restarts netBae). When an update adds options, your config isn't overwritten: the new defaults are saved next to it as `config.toml.default`. All schedules follow the wall clock (local time): `interval_minutes = 30` with `offset_minutes = 6` runs at :06 and :36 whatever time netBae started.

### All options

<details>
<summary><b>[web] [storage] [ping] [dns]</b></summary>

| Option | Default | |
|---|---|---|
| `[web] host` | `"0.0.0.0"` | `0.0.0.0` = reachable from your network; `"::"` for IPv6 too |
| `[web] update_check` | `true` | check GitHub for a newer release and show an **Update** button in the dashboard's header |
| `[web] update_check_hours` | `6` | how often to check for a new release, in hours (1 to 168) |
| `[web] auto_update` | `"weekly"` | install new releases by itself: `"weekly"` (at most once a week) or `"daily"` at `auto_update_time`, `"immediately"` (as soon as a check finds one), or `"off"`. Not in Docker or on NixOS |
| `[web] auto_update_time` | `"03:30"` | when `"weekly"` and `"daily"` updates install, local time (24-hour) |
| `[web] start_at_boot` | `true` | start netBae when the machine boots. `false`: it runs only after `netbae start` and stays stopped after a reboot. Applied by `netbae config`, `start` and `restart`. On NixOS it's `services.netbae.startAtBoot`; in Docker use the container's restart policy instead |
| `[web] chart_band` | `"none"` | the latency charts' spread band by default: `"none"`, `"p5-p95"` or `"min-max"`. Each browser remembers its own choice, and the band is drawn when 12 or fewer lines are showing |
| `[web] port` | `80` | if it's taken when netBae starts, the next free port is used and the log says which |
| `[storage] database` | `/var/lib/netbae/netbae.db` | the history database |
| `[storage] raw_retention_days` | `7` | every sample |
| `[storage] minute_retention_days` | `90` | 1-minute summaries (count, average, min, max and a latency histogram) |
| `[storage] retention_days` | `0` | hourly summaries, speedtests and system history (`0` = forever) |
| `[ping] interval_seconds` / `offset_seconds` | `30` / `0` | |
| `[ping] timeout_seconds` | `2` | |
| `[ping] extra_targets` | none | your own hosts, added to the built-in list: `{ name, host, group }`; `host = "gateway"` = your router; `method = "tcp"` (with `port`) for hosts that block ping; game servers below. One with the same host as a built-in target replaces it |
| `[ping] disable` | none | built-in targets to switch off, by name or group, e.g. `["Streaming AU", "Hetzner Falkenstein"]` |
| `[ping] targets` | not set | set it to use only your own list instead of the built-in one |
| `[ping] regions` | Nearest + 19 cities | latency to the fastest Ookla server in each city (Nearest: the closest to you), see [Regions](#region-speedtests-and-pings) |
| `[ping] region_interval_seconds` | `60` | |
| `[ping] ipv6` | `true` | also ping each site over IPv6 (a separate line) when this machine and the site have IPv6, and each region over IPv6 to a speedtest server there that has it. Not the router, game servers or secondary connections |
| `[dns] enabled` | `true` | |
| `[dns] interval_seconds` / `offset_seconds` / `timeout_seconds` | `30` / `0` / `2` | |
| `[dns] extra_servers` | none | your own DNS servers, added to the built-in ones in `targets.toml` (router, DHCP DNS + 9 public resolvers, IPv4 and IPv6): `{ name, host }`; `host = "dhcp"` adds the IPv4 and IPv6 DNS servers DHCP (or router adverts) gave this machine if they aren't the router; `host = "gateway"` is the router over IPv4, plus its IPv6 address when it answers DNS there; IPv6 servers are skipped on IPv4-only networks |
| `[dns] extra_domains` | none | more names for each resolver to look up, on top of the 5 built-in ones |
| `[dns] disable` | `[]` | built-in servers (by name or host) or domains to leave out |
| `[cdn] enabled` | `true` | the DNS and CDN test: which CDN server each `[dns]` server sends you to |
| `[cdn] extra_hostnames` | none | more names to look up through every DNS server, on top of the built-in CDNs in `targets.toml` (Akamai, Google, Microsoft, Cloudflare, Amazon CloudFront, Fastly, Meta): `{ name, host }`, where names that match share a column |
| `[cdn] disable` | `[]` | built-in CDNs (by name or hostname) to leave out |
| `[cdn] interval_minutes` / `offset_minutes` | `30` / `20` | |
| `[cdn] pings` / `trace_hours` | `5` / `6` | pings per address each run; trace each address at most every 6 hours (`0` = no traces) |

</details>

<details>
<summary><b>[speedtest] [isp] [traceroute] [system]</b></summary>

| Option | Default | |
|---|---|---|
| `[speedtest] enabled` | `true` | automatic speedtests: the schedule (main, regions and secondary connections) and the first test after a new install. `false` stops them all |
| `[speedtest] manual` | `true` | the dashboard's Run buttons, even when `enabled = false`. Set both to `false` to turn speedtests off completely |
| `[speedtest] interval_minutes` / `offset_minutes` | `60` / `0` | e.g. `offset_minutes = 6` runs at :06 every hour |
| `[speedtest] servers` | `[]` | empty = Ookla picks the closest; or server IDs from `speedtest -L`, each tested in turn |
| `[speedtest] regions` | `[]` | cities to speedtest, e.g. `["Sydney", "Singapore", "London"]` |
| `[speedtest] global_every` | `5` | after every 5 main speedtests, one more to a random server somewhere in the world, see [Global speedtests](#global-speedtests) (`0` = off) |
| `[speedtest] busy_check` / `busy_percent` / `busy_wait_minutes` | `true` / `10` / `30` | before a scheduled test, wait while other traffic is over 10% of your last result (checked every 3 minutes), then test anyway after 30 minutes and mark it busy. Uses the router's traffic counters over UPnP when it offers them (every device), otherwise only this machine's traffic. **Run now** never waits |
| `[speedtest] regions_interval_minutes` / `regions_offset_minutes` | `1440` / `30` | once a day, at 00:30 |
| `[speedtest] binary` | `"auto"` | path to the Ookla CLI, or `auto` to find it |
| `[speedtest] timeout_seconds` | `300` | |
| `[isp] enabled` | `true` | each connection's public IP and ISP, from ipinfo.io |
| `[isp] interval_minutes` / `offset_minutes` | `10` / `0` | |
| `[isp] main_name` | `"Main"` | what to call your main connection |
| `[traceroute] enabled` | `true` | |
| `[traceroute] interval_hours` / `offset_minutes` | `12` / `15` | |
| `[traceroute] max_hops` / `parallel` | `25` / `6` | traces at once |
| `[traceroute] ipv6` | `true` | also trace the IPv6 route to every site pinged over IPv6 |
| `[system] interval_seconds` / `offset_seconds` | `30` / `0` | CPU, RAM, load, temperature, storage |
| `[system] disk_path` | `"/"` | the drive shown as Boot drive. The dashboard also shows every local drive added up (partitions, USB and extra disks, ZFS pools; not network shares) when there's more than one |

</details>

<details>
<summary><b>[public] [[connections]]</b></summary>

| Option | Default | |
|---|---|---|
| `[public] enabled` | `false` | a read-only copy of the dashboard for sharing, see [below](#sharing-a-public-dashboard) |
| `[public] host` / `port` | `"0.0.0.0"` / `8080` | `"127.0.0.1"` when the tunnel runs on this machine (`netbae tunnel` sets it) |
| `[public] requests_per_minute` | `120` | per visitor; an open dashboard needs about 20 |
| `[public] total_requests_per_minute` | `1200` | all visitors together |
| `[public] hide` | `[]` | more addresses, prefixes or domains to hide, e.g. `["198.51.100.0/24", "example.com"]` |
| `[public] show_hostname` | `false` | show this machine's name (often includes yours, e.g. `Sams-Pi`) |
| `[public] show_city` | `true` | `false` shows only the country of your ISP location and drops each route's first city |
| `[public] access_team` / `access_aud` | `""` / `""` | Cloudflare Access sign-in on the public address, so you get your own dashboard there: your Zero Trust team name and the application's AUD tag, see [Signing in](#signing-in-to-your-own-dashboard) |
| `[[connections]] name` / `bind` | | a secondary connection: its name and the IP or interface to send from, see [below](#monitoring-a-secondary-connection) |
| `[[connections]] targets` | `1.1.1.1`, `8.8.8.8`, `google.com` | what to ping over it, or `"all"` for every main target |
| `[[connections]] speedtest` | `true` | |
| `[[connections]] speedtest_interval_minutes` / `speedtest_offset_minutes` | `1440` / `45` | daily (`0` = only when you press Run) |

</details>

### Ping targets

netBae's built-in list (78 hosts in 15 groups) lives in its own file, [`app/targets.toml`](app/targets.toml), along with the built-in DNS servers, DNS domains and CDN names, installed next to `netbae.py` (`/opt/netbae/targets.toml` on Linux and in Docker, `/usr/local/lib/netbae` on macOS, `C:\Program Files\netBae` on Windows). It's replaced on every update, so new default targets show up by themselves. Don't edit it: add your own hosts with `extra_targets` and switch built-in ones off with `disable` in `config.toml`:

```toml
[ping]
extra_targets = [
  { name = "My server", host = "example.com", group = "Mine" },
  { name = "Amazon", host = "amazon.com", method = "tcp", port = 443, group = "Shopping" },
]
disable = ["Streaming AU", "China cloud & CDN"]
```

Configs from before 1.8 list every target under `[ping] targets`. When that list is one netBae shipped (whichever version you started on, with or without your changes), netBae switches to today's built-in list by itself, so new targets keep arriving: hosts you added, and defaults you renamed or regrouped, are kept as if they were in `extra_targets`, and defaults you deleted stay off as if they were in `disable`. Your config file isn't changed; the log says what was carried over and how to make it permanent. A list that's mostly your own hosts is used exactly as written.

### Game servers

Game companies don't publish servers you can ping, so netBae measures what their own clients use. It picks the server nearest you and shows which one it chose on the tile, e.g. *Sydney (nearest)*.

| Target | What's measured | Pin a region |
|---|---|---|
| `valve:auto` (Steam & CS2) | the nearest [Steam Datagram Relay](https://partner.steamgames.com/doc/features/multiplayer/steamdatagramrelay); CS2 and Dota 2 traffic runs through these | `valve:syd`, `valve:sgp`, `valve:lax`, `valve:fra` … |
| `epic:auto` (Fortnite) | Epic's regional ping beacons, which Fortnite uses to choose a region | `epic:oce`, `naw`, `nac`, `nae`, `eu`, `asia`, `me`, `br` |
| `discord:auto` (Discord voice) | the nearest Discord voice server, from Discord's own latency service | `discord:sydney`, `discord:singapore` … |
| `gamelift:auto` (AWS GameLift) | the nearest [AWS GameLift UDP ping beacon](https://docs.aws.amazon.com/gamelift/latest/developerguide/reference-udp-ping-beacons.html); many games host their servers on GameLift | `gamelift:ap-southeast-2`, `us-west-2`, `eu-central-1` … |

Battle.net (Blizzard's login service, TCP 1119) and Minecraft (the Hypixel server, TCP 25565) are fixed hosts.

**Not possible:** Riot (Valorant, League of Legends) and Activision (Warzone) block ping and connection tests to their game servers, and Blizzard (Overwatch), EA (Apex Legends) and Ubisoft (Rainbow Six Siege) change their game server addresses (partly to resist DDoS attacks), so no tool can measure them from outside the game. Guessed IPs would only give misleading numbers.

### Region speedtests and pings

Built-in cities: **Nearest** (the Ookla servers closest to you, wherever you are; the summary bar shows it as **Internet latency**) · 🇦🇺 Sydney, Melbourne, Perth · 🇳🇿 Auckland · 🇸🇬 Singapore · 🇭🇰 Hong Kong · 🇯🇵 Tokyo · 🇬🇺 Guam · 🇮🇳 Delhi · 🇴🇲 Oman · 🇺🇸 Los Angeles, New York · 🇨🇦 Toronto · 🇧🇷 São Paulo · 🇬🇧 London · 🇳🇱 Amsterdam · 🇫🇷 Paris · 🇮🇹 Milan · 🇿🇦 Cape Town.

netBae looks up the Ookla servers in each city, measures them and uses the fastest. It retries the next one if a server fails and refreshes the list daily. Add your own with `{ name = "Frankfurt", city = "Frankfurt", country = "Germany", flag = "DE" }` or `{ name = "Work", server_id = 12345 }`. Ookla has no public servers in mainland China, so Hong Kong is the closest.

Each speedtest can use 0.5–1 GB on a fast connection, so region speedtests are off by default and run daily once enabled. Tests never overlap.

### Global speedtests

After every 5 successful main speedtests (scheduled or **Run now**), netBae runs one more to a random Ookla server in a random city: the region cities above plus Frankfurt, Stockholm, Madrid, Warsaw, Dubai, Johannesburg, Nairobi, Lagos, Cairo, Mumbai, Bangkok, Jakarta, Manila, Kuala Lumpur, Seoul, Taipei, Osaka, Chicago, Dallas, Miami, Seattle, Honolulu, Vancouver, Mexico City, Buenos Aires, Santiago and Lima. It avoids the last five cities it used. The results show how your connection copes with long distances, and they have their own **Global speedtests** section with a 30-day average; they're never counted in your own speedtest averages or history. Change how often with `global_every` under `[speedtest]` (`0` turns them off). With hourly speedtests that's about 5 extra tests a day, each using up to as much data as a normal test.

### Monitoring a secondary connection

If you have a second internet connection (for example a 5G/4G link your router fails over to), you can test it at the same time as your main one. netBae sends the secondary connection's tests from a **second IP address** on the monitoring machine, and your router sends traffic from that IP out of the secondary WAN.

**1. Give the machine a second IP address** on your LAN, outside your router's DHCP range:

Raspberry Pi OS (bookworm) / NetworkManager:

```bash
sudo nmcli con mod "Wired connection 1" +ipv4.addresses 192.168.1.51/24 && sudo nmcli con up "Wired connection 1"
```

(netplan: add it under `addresses:`; ifupdown: `up ip addr add 192.168.1.51/24 dev eth0`.)

macOS: a second "service" on the same port, with a manual IP (survives reboots):

```bash
sudo networksetup -duplicatenetworkservice "Ethernet" "netBae secondary"
sudo networksetup -setmanual "netBae secondary" 192.168.1.51 255.255.255.0 192.168.1.1
```

Windows (admin PowerShell). The adapter must have a static IP: Windows can't add an address to a DHCP adapter.

```powershell
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.1.51 -PrefixLength 24 -SkipAsSource $true
```

`-SkipAsSource` stops Windows using the new address for normal traffic; netBae still sends from it when told to.

**2. Route that IP out of the secondary WAN on your router.** A normal *static route* matches the destination, but this needs a **source-based (policy) route**: *source 192.168.1.51 → WAN2*. Routers call it Policy Routing (TP-Link Omada, DrayTek), Policy-Based Routes / Traffic Routes (UniFi), a firewall rule with a gateway (pfSense/OPNsense) or a routing mark (MikroTik). If you can, turn off failover for that rule, so the secondary tests fail when the secondary connection is down instead of quietly using your main connection.

**Alternative:** plug a second network adapter (USB Ethernet or Wi-Fi) into the secondary modem and use its interface name (Linux, e.g. `eth1`; macOS, e.g. `en7`) instead of an IP. On Windows, use the adapter's IP address.

**3. Add the connection** with `netbae config`:

```toml
[[connections]]
name = "Secondary"
bind = "192.168.1.51"          # or an interface: "eth1" on Linux, "en7" on macOS
targets = ["1.1.1.1", "8.8.8.8", "google.com", "valve:auto"]   # or "all": every main ping target
speedtest_interval_minutes = 1440   # daily, to save data on mobile plans (0 = only when you press Run)
```

The connection gets its own group of ping tiles and its own row in the speedtest table, with its ISP and data used, so you can compare it with your main line.

## Sharing a public dashboard

netBae can serve a read-only copy of your dashboard for people outside your home. It's off by default.

It isn't a separate app: it's the same dashboard, served by the same netBae service on a second port, with a stricter set of rules. Every answer on the public port is checked and masked before it leaves.

**The two ports** are separate settings, and neither follows the other:

| | Setting | Default | Who reaches it |
|---|---|---|---|
| Your own dashboard | `[web] port` | `80`, or the next free port (81, 82 …) if 80 was taken at install | devices on your network |
| The public dashboard | `[public] port` | `8080` | the tunnel, when `[public] host = "127.0.0.1"` (what `netbae tunnel` sets) |

Change either with `netbae config`. The tunnel must point at the public port, never at your own dashboard's port. Your own dashboard shows, under the ISP line in the header, whether the public one is shared, its address, whether it's reachable from the internet and how many people visited in the last hour (visits from your own network aren't counted, and the count restarts with netBae).

### The easy way: `netbae tunnel`

One command turns on the public dashboard and shares it through a tunnel, so you don't open any port on your router:

```bash
netbae tunnel
```

It asks which kind you want:

| | Address | Needs |
|---|---|---|
| `netbae tunnel quick` | a random `https://....trycloudflare.com`, new each time | nothing; stops when you press Ctrl-C |
| `netbae tunnel cloudflare netbae.example.com` | your own hostname, permanent | a free Cloudflare account with your domain on it |
| `netbae tunnel tailscale` | `https://<machine>.<tailnet>.ts.net`, permanent | a free Tailscale account |

netBae installs `cloudflared` or Tailscale from their official sources if needed (and updates an installed `cloudflared` each time it runs), sets `[public] enabled = true` and `host = "127.0.0.1"` (so only the tunnel can reach it), restarts netBae and prints your public address. The only step it can't do for you is the first sign-in: it shows a link to open in your browser, then carries on. Cloudflare tunnels run as the `netbae-tunnel` service (a `netBae tunnel` scheduled task on Windows) under the same unprivileged account as netBae, and start at boot. Tailscale Funnel runs inside Tailscale itself.

- More than one hostname? Give several (`netbae tunnel cloudflare netbae.example.com status.example.org`) or run it again with another: each run adds to the hostnames already shared, all through the same tunnel. `netbae tunnel remove <hostname>` stops sharing on one.
- `netbae tunnel status` shows what's shared and where.
- `netbae tunnel off` stops sharing and turns the public dashboard off (your Cloudflare login is kept, so turning it back on is one command).
- Made a tunnel in the Cloudflare dashboard instead? `netbae tunnel cloudflare --token <token>` runs it. Give it a public hostname with service `http://127.0.0.1:8080` (your `[public] port`).
- NixOS: the same commands, but the tunnel is turned on in your NixOS configuration (see [NixOS](#nixos)).
- Docker: `netbae tunnel` isn't available in the container, see [With Docker](#with-docker) below.

### With Docker

In Docker, run Cloudflare's `cloudflared` container next to netBae. [docker-compose.yml](docker-compose.yml) already has it, commented out.

1. Turn on the public dashboard in `netbae-data/config.toml` (`sudo nano netbae-data/config.toml`), then run `docker compose restart netbae`:

   ```toml
   [public]
   enabled = true
   host = "127.0.0.1"   # only the tunnel, running on the same host, can reach it
   port = 8080
   ```

2. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) go to **Networks → Tunnels → Create a tunnel** and choose **Cloudflared**. Copy the token from the install command it shows (the long string after `--token`).
3. Add a **public hostname** to the tunnel: e.g. `netbae.example.com`, service type `HTTP`, URL `127.0.0.1:8080`. To share the dashboard on more than one address, add another public hostname with the same URL.
4. In `docker-compose.yml`, uncomment the `cloudflared` service and paste in your token:

   ```yaml
     cloudflared:
       image: cloudflare/cloudflared:latest
       container_name: netbae-tunnel
       restart: unless-stopped
       network_mode: host
       command: tunnel --no-autoupdate run
       environment:
         TUNNEL_TOKEN: "paste-your-tunnel-token-here"
   ```

5. Run `docker compose up -d` and open `https://netbae.example.com`. Your own dashboard shows whether the tunnel is connected and reachable.

No domain? For a quick test, use `command: tunnel --no-autoupdate --url http://127.0.0.1:8080` and leave out `TUNNEL_TOKEN`. `docker logs netbae-tunnel` shows a random `https://....trycloudflare.com` address, which changes every time the container restarts.

With `docker run` instead of Compose:

```bash
docker run -d --name netbae-tunnel --network host --restart unless-stopped \
  -e TUNNEL_TOKEN="paste-your-tunnel-token-here" \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run
```

To stop sharing, comment the `cloudflared` service out again and run `docker compose up -d --remove-orphans` (or `docker rm -f netbae-tunnel`), then set `[public] enabled = false` and run `docker compose restart netbae`.

### What visitors see

The same charts and tables as on your own dashboard, with these differences:

- **Read-only.** Visitors can browse every chart, range and route, but the Run buttons are gone and the server refuses every request that would start something (`POST` returns `403`). Speedtests and traces only run on their normal schedule.
- **Rate-limited.** Each visitor gets `requests_per_minute` (120) and everyone together `total_requests_per_minute` (1200). An open dashboard needs about 20 a minute, and the public page refreshes every 30 seconds instead of 15. Past the limit visitors get `429` with a `Retry-After`. At most 32 public requests are worked on at once, and stalled connections are dropped after 20 seconds. Behind a tunnel or proxy on your network, the visitor's real address (`CF-Connecting-IP`, `X-Real-IP` or `X-Forwarded-For`) is what's limited.
- **You're hidden.** This applies to everything the public page shows: ISP history, DNS servers, routes, hostnames and errors.
  - Your public IPv4 addresses show only the first half (`203.0.x.x`). Hostnames that carry them in any common form (`203-0-113-5`, `5.113.0.203`, `203000113005`, hex) show as `(hidden)`.
  - IPv6 addresses in your /48, including your router's, show only the ISP's /32 (`2403:5800:x:x:x:x:x:x`). Matching on the /48 covers every subnet you have, whether your ISP hands out a /48, /56, /60 or /64. netBae remembers every prefix it has seen on this machine's interfaces, so addresses from an old prefix stay hidden after your ISP changes it.
  - Any name on your own domain shows as `(hidden)`, e.g. a router called `unifi.home.example.com`. Your domains are found from the router's and this machine's names and the DNS search domain (names ending in `.lan`, `.local` or `.home.arpa` aren't treated as domains, since they don't identify you).
  - Hops inside your network keep their address but lose their name.
  - This machine's name (often includes yours, e.g. `Sams-Pi`) is hidden. Set `show_hostname = true` to show it.
  - The ISP location shows the city, as on your own dashboard. Set `show_city = false` to show only the country, and to drop the first city of every route (yours), including the names of the routers there. Speedtest servers still show their city, and the nearest one is usually in or near yours.
  - Add anything else to `hide`, e.g. `hide = ["198.51.100.0/24", "example.com"]`.

  Internal addresses (router, this machine) and the DNS servers are shown as on your own dashboard.

### Signing in to your own dashboard

With a Cloudflare Tunnel, your public address can double as your own dashboard away from home. Visitors see the public view. You click **Sign in** in the header, sign in through Cloudflare Access, and the same address shows your full dashboard with the Run and Update buttons. **Sign out** goes back to the public view. At home, your own dashboard's port never needs a sign-in.

Set it up once in [Cloudflare Zero Trust](https://one.dash.cloudflare.com/):

1. **Access → Applications → Add an application → Self-hosted.** Enter your dashboard's hostname (e.g. `netbae.example.com`) with the path `login`. Only `/login` is protected, so the rest stays public.
2. **Add a policy:** action **Allow**, include **Emails**, your email address. Access is free for up to 50 users, and you can sign in with an emailed code, Google, GitHub and others.
3. **Copy two values:** the application's **Application Audience (AUD) tag**, from its overview, and your team name, the `<team>` in `<team>.cloudflareaccess.com` (under **Settings → Custom pages**).
4. **Add them to the config** with `netbae config`, which restarts netBae:

   ```toml
   [public]
   access_team = "myteam"
   access_aud = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2"
   ```

**Why it's safe:** after you sign in, Cloudflare sends netBae a signed token. netBae checks the signature against your team's published keys, that the token is for this application and that it hasn't expired, then keeps it as a cookie until it expires. Without a valid token, every request gets the public view, so a missing or wrong Access setup can't expose your dashboard; `/login` just says sign-in isn't set up yet. Signed-in requests aren't rate-limited or counted as visitors.

### By hand

```toml
[public]
enabled = true
host = "127.0.0.1"   # if the tunnel runs on the same machine; "0.0.0.0" if it runs elsewhere on your LAN
port = 8080
```

Restart netBae (`sudo systemctl restart netbae`, or `docker compose restart`) and the log shows both ports.

**Don't port-forward it on your router.** Visitors would connect to your home IP, so they'd see it in full whatever the page hides, and the Pi would be straight on the internet without HTTPS. netBae logs a warning (`netbae logs`) when a visitor reaches the public port straight from the internet. Use a tunnel instead (`netbae tunnel` sets these up for you):

#### Cloudflare Tunnel (free, needs a domain on Cloudflare)

A small program, `cloudflared`, runs on the Pi and makes an outgoing connection to Cloudflare. Visitors go to a hostname like `netbae.example.com`, Cloudflare passes their requests down that connection to `http://127.0.0.1:8080`, and the answers go back the same way. Nothing on your router is opened, visitors only ever see Cloudflare's addresses, and Cloudflare absorbs floods and bots before they reach your connection.

1. Add your domain to Cloudflare (any registrar works, the free plan is enough).
2. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) go to **Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, and run the install command it shows on the Pi (Debian, Ubuntu, Raspberry Pi OS, Docker and others are listed).
3. Add a **public hostname**: e.g. `netbae.example.com`, service type `HTTP`, URL `127.0.0.1:8080` (use the Pi's LAN IP if `cloudflared` runs on another machine).
4. Open `https://netbae.example.com`. Cloudflare adds HTTPS automatically.

Point the tunnel at the public port (8080), never at your own dashboard's port. To get your own dashboard on the same address, see [Signing in](#signing-in-to-your-own-dashboard). To let only invited people see the public one, protect the whole hostname (no path) with a Cloudflare Access application instead.

#### Tailscale Funnel (no domain needed)

If you use [Tailscale](https://tailscale.com/), run `sudo tailscale funnel --bg 8080` on the Pi. The dashboard appears at `https://<machine>.<tailnet>.ts.net` for anyone with the link. Turn it off with `sudo tailscale funnel reset`.

## How it measures

- **Ping:** one ICMP echo per host per interval, using the system `ping`. Hosts that block ping can use a timed TCP connect instead. When 5 or more hosts that answered last time fail in the same round, they're pinged again a second later and the answers kept: on a busy machine (swapping or a slow disk), a short stall makes every ping in flight miss its reply, router included, and they'd all look down. Hosts that also miss the re-check count as failed, and one or two failures (ordinary packet loss) are never re-checked. The log notes each re-check.
- **Router:** `gateway` reads the default route from the kernel (`/proc/net/route`; `route get default` on macOS, `route print` on Windows), so it follows whatever router you're using.
- **Sites:** each name is pinged at the address it resolves to, which for big services is their nearest edge or CDN server. That's the path your real traffic takes.
- **IPv4 and IPv6:** when this machine has an IPv6 route, each site is pinged at its IPv4 address and, if it has one, its IPv6 address, stored as two separate series (the public resolvers' IPv4 addresses are paired with their IPv6 ones, e.g. 1.1.1.1 with 2606:4700:4700::1111). Regions use the same speedtest server over IPv6 when it has an IPv6 address, otherwise the fastest one in that city that does. Sites without IPv6 just have no IPv6 line, and nothing is recorded for IPv6 on an IPv4-only network. Fake "IPv6" addresses that still go over IPv4 (IPv4-mapped `::ffff:` and NAT64 `64:ff9b::`) are ignored. Routes are traced over both too.
- **DNS and CDN:** CDNs such as Akamai, Google and Microsoft answer with a server near the DNS resolver that asked (or near you, if the resolver passes on part of your address with EDNS Client Subnet, like Quad9's 9.9.9.11). Cloudflare is the exception: it uses the same anycast addresses everywhere and your ISP's routing picks the site, so it's there as a baseline. Every 30 minutes each resolver looks up the `[cdn] hostnames`; every address it hands out is pinged 5 times and traced every 6 hours. A resolver's score is the average latency to its addresses, averaged per hostname so a name with six addresses counts the same as one with one, and the dashboard lists the resolvers fastest first with a 7-day average. A resolver near the top is one whose answers send you to nearby servers.
- **DNS:** one UDP A-record query per resolver and domain, timed in Python, over IPv4 and IPv6. "DHCP DNS" is read from the system's resolver settings (`/etc/resolv.conf` or systemd-resolved on Linux and macOS, the network adapter settings on Windows) at startup. An IPv6 DNS server with the same MAC address as the default gateway (from the ARP and neighbour tables) is the router, shown as Router v6; failing that, the router's link-local IPv6 address is used if it answers DNS.
- **ISP:** an HTTPS request to [ipinfo.io](https://ipinfo.io) through each connection (main and secondary) returns its public IP and ISP. The header shows the current one, and the System history chart marks every check along its top, one row per connection: a tick in the ISP's colour, or a cross when the check failed (coloured for the ISP the connection was on). A larger mark means the ISP or IP changed. Click an ISP above the chart to hide its marks. ipinfo.io sees your public IP, about 4,500 requests a month per connection at the default interval (its free tier allows 50,000).
- **Routes:** the system `traceroute` (`tracert` on Windows) to each target every 12 hours, and right after netBae starts for any target that has no recent route. Each hop's network comes from [Team Cymru's IP-to-ASN service](https://www.team-cymru.com/ip-asn-mapping) over DNS. A route is **on-net** if the destination is inside your ISP, **direct** if your ISP connects straight to the destination's network (a private interconnect), **IX** if your ISP hands the traffic over across an internet exchange (hops on an exchange's peering LAN, using [PeeringDB](https://www.peeringdb.com)'s prefix list, refreshed daily), even when a transit carrier follows the exchange, and **transit** if your ISP hands it straight to another carrier. Each hand-over is also labelled with the business relationship between the two networks (**peering**, **paid transit**, or **to customer**) from [CAIDA's AS relationships](https://www.caida.org/catalog/datasets/as-relationships/), inferred from public BGP data, published monthly and downloaded once a month (~10 MB on disk). Each hop also gets a **location**, from the city code most backbone routers carry in their name (`be3021.ccr41.syd01.atlas.cogentco.com` is Sydney), or else from ipinfo.io's IP geolocation, marked `~` as approximate. A geolocated city is dropped if the hop answered too fast to be that far away (light in fibre covers about 100 km per millisecond of round trip), which weeds out anycast addresses like 8.8.8.8. Geolocation results are cached for 30 days and capped at 300 lookups a day. Traceroute only sees routers that answer it, so treat it as a strong hint, not proof.
- **Speedtests:** the official Ookla CLI, auto-selecting the closest server unless you choose one. A new install runs its first test a few minutes after starting, once the first routes are traced (unless `[speedtest] enabled = false`). Before each scheduled test, netBae checks whether the network is busy (see `busy_check` under [All options](#all-options)), and the bottom of the dashboard lists how often each kind of test runs. Every test (scheduled, **Run now**, region, global and secondary) first waits for any running ping, DNS check or trace to finish. During the test, pings and DNS checks are skipped, so the charts show a short gap instead of the test's own traffic, and traces wait until it's done. System stats keep recording.
- **System:** the model name comes from the device tree on a Raspberry Pi (`/proc/device-tree/model`), DMI/BIOS info on PCs and VMs, `sysctl` on a Mac and the registry on Windows.

## Averages and storage

Averages ignore large outliers, so one bad spike doesn't skew them. Min, max and P95 still show every spike:

- **Ping and DNS:** the fastest and slowest 5% of samples are left out of each average once there are at least 10 samples.
- **Speedtests:** download, upload, ping and jitter averages leave out results beyond 1.5× the interquartile range (e.g. one test that hit a congested server). Packet loss is never trimmed.

### Storage

History is kept in SQLite at three resolutions:

- every sample for `raw_retention_days` (7)
- 1-minute summaries (count, average, min, max and a latency histogram) for `minute_retention_days` (90)
- hourly summaries, speedtests and system history for `retention_days` (0 = forever)

Charts automatically use the right one, so a whole year loads instantly even on a Pi. P5 and P95 are exact for ranges up to 6 hours (worked out from every sample) and within a few percent beyond that: percentiles of 1-minute summaries can't be combined, so each summary also counts its samples in 48 latency bins (0.3 ms to 1 s, each 18% wider than the last), and those counts add up exactly over any range. History from before 1.8 has no histograms and shows the older, rougher P5/P95 (the average of each minute's lowest and highest). Two reference files sit next to the database and refresh themselves: PeeringDB's internet-exchange prefixes (`peeringdb-ix.json`, daily) and CAIDA's AS relationships (`as-rel-YYYYMM.db`, about 10 MB, monthly). With the defaults (78 hosts, 20 regions, 20 DNS servers × 5 domains, most of them over IPv4 and IPv6), the database levels off at roughly 2.5 GB once it holds 90 days, then grows by about 300 MB a year (roughly 2.8 GB after the first year):

| What | Kept | Size |
|---|---|---|
| Every ping and DNS lookup | 7 days | ~485 MB (ping 395, DNS 90) |
| 1-minute summaries | 90 days | ~2 GB (ping 1, DNS 1) |
| Hourly summaries, speedtests, system, ISP checks, routes | forever | ~300 MB a year |

Host names, DNS servers and domains are stored once and referred to by number, and each table is stored in (host, time) order so it needs only one extra index (by time).

To use less: `minute_retention_days = 30` saves about 1.2 GB, fewer DNS `domains` or servers shrink the DNS share (IPv6 servers are skipped on networks without IPv6), and `disable` drops ping targets you don't care about.

## Behind a reverse proxy

netBae works behind Nginx, Caddy, Traefik or Nginx Proxy Manager, on its own hostname or under a sub-path. Caddy:

```
netbae.home.lan {
    reverse_proxy 192.168.1.50:80
}
```

Your own dashboard has no login, so keep it on your LAN, or add auth at the proxy. To reach it from outside, use the [public dashboard](#sharing-a-public-dashboard) with [Cloudflare Access sign-in](#signing-in-to-your-own-dashboard), or a VPN such as Tailscale. To let other people see it, use the public dashboard.

## API

Everything on the dashboard comes from a small JSON API you can use from Home Assistant, Grafana or scripts:
`/api/summary`, `/api/config`, `/api/system`, `/api/system/history`, `/api/ping`, `/api/dns`, `/api/speedtest`, `/api/isp` (query: `from`, `to` in Unix seconds, plus `targets` / `servers` / `domain`), `/api/traceroute?target=<id>` (hops and route history, with each network's relationship to the one before it), `/api/cdn` (the DNS and CDN ranking), `POST /api/speedtest/run?scope=main|regions|global|conn:<name>` and `POST /api/cdn/run`. Your own dashboard also has `/api/sharing` (the public dashboard's tunnels and visitors), `/api/update`, `POST /api/update/check` (check GitHub now) and `POST /api/update/run`. The [public dashboard](#sharing-a-public-dashboard) serves the same `GET` API, rate-limited and masked, and refuses `POST`, except for someone [signed in](#signing-in-to-your-own-dashboard), who gets your own dashboard's API.

## FAQ

**Does it run on Windows?** Yes, Windows 10 and 11, with `install.ps1` (see [Install](#install)). Windows can't run `install.sh` because it has no bash, so it has its own installer.

**How much data does it use?** Pings and DNS are tiny (a few MB a day). Speedtests are what count: each uses roughly what your connection can move in about 20 seconds. On a gigabit line that's about 1 GB per test, so hourly tests add up. The dashboard shows data used per test and per day.

**What do on-net, direct, IX and transit mean on a route?** They describe how traffic gets from your ISP to the network that owns the destination address:

- **on-net**: the destination is inside your ISP's own network.
- **direct**: your ISP hands traffic straight to the destination's network over a private link. ChatGPT is a good example: `chatgpt.com` is on Cloudflare's addresses, and Superloop connects straight to Cloudflare, so the route is Superloop → Cloudflare.
- **IX**: the hand-over happens at an internet exchange (a shared switch where many networks meet, like MegaIX Melbourne), still without a carrier in between.
- **transit**: another network sits between your ISP and the destination. Claude is an example: `claude.ai` is on Anthropic's own addresses, with Cloudflare in front of it, so the route is Superloop → Cloudflare → Anthropic and Cloudflare counts as the network in the middle. Transit isn't automatically slower: here Cloudflare picks the traffic up in Melbourne and both sites ping about the same. It matters more when the middle network is a long-haul carrier like Cogent or GTT.

The destination is named only when it isn't the site itself ("direct to Cloudflare" for ChatGPT, just "direct" for Google). The grey word after a route, such as **· peering** or **· paid transit**, is the business relationship at the first hand-over (see below). It's left out when CAIDA's data doesn't know the two networks' relationship, so "direct" and "direct · peering" are the same kind of route; one just has the relationship known.

**What's the difference between transit and peering?** Transit is paid access to the whole internet: your ISP pays a carrier like Cogent or GTT to deliver its traffic anywhere. Peering is two networks swapping traffic only between themselves and their own customers, usually for free (sometimes paid when the traffic is lopsided, which still counts as peering). A route that's **direct** or via an **IX** and labelled **peering** is usually the shortest and least congested way in. **Transit** adds another network in the middle. The labels come from CAIDA's data, inferred from public routing tables, so treat them as a well-informed guess.

**Can I show certain groups expanded, e.g. on a wall display?** Open `http://<machine>/?expand=Gaming,DNS`.

**By running speedtests**, you accept [Ookla's EULA and privacy policy](https://www.speedtest.net/about/eula). netBae passes `--accept-license --accept-gdpr` to the CLI.

## How it's tested

Every release has to pass these on fresh machines before it's published:

- **Code checks:** shellcheck on the shell scripts, Python syntax, the default config, a smoke test of the app and the release archive build.
- **Linux installer:** the real `install.sh` in systemd containers on Debian 12, Debian 13, Ubuntu 24.04 and Fedora: install, check the service, API, Ookla CLI and data collection, update in place, uninstall keeping the config, reinstall, then uninstall with `--purge` and check nothing is left.
- **macOS installer:** the full install, update and uninstall on a Mac.
- **Windows installer:** `install.ps1` on Windows, including a real speedtest through the service, the `irm | iex` path and `-Purge`.
- **Docker:** the image is started in host and bridge networking and checked, then built for amd64, arm64 and arm/v7.

Changes to the database format are also tested by upgrading a database made by the previous version and comparing the results of the same queries before and after, and the built-in targets are checked to resolve.

### Known limitations

- **Some games can't be measured:** Valorant, League of Legends and Warzone don't publish servers that answer pings.
- **Routes are a strong hint, not proof:** traceroute only sees routers that answer it, and hop locations are a best estimate.
- **Secondary connections are IPv4 only:** they're bound to an IPv4 source address, so they don't get IPv6 lines.
- **Docker on a Mac or Windows** runs in a hidden VM, so it measures the VM's network; the native installers are more accurate there. In Docker, "All drives" isn't shown because a container can't see the host's other drives.
- **Raspberry Pi:** the arm64 and arm/v7 Docker images are built for every release, and the installer is tested on Debian, but the automated tests run on x86 and Apple Silicon machines rather than a physical Pi.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). netBae has no build step: edit, run `python3 app/netbae.py -c <your config>`, refresh. It needs Python 3.8+ with `tomli`, or 3.11+ (the installers set this up; on a Mac, use Homebrew's `python3`).

## Support

netBae is free for personal use. If it's useful to you, you can [buy me a coffee](https://buymeacoffee.com/jchin14). Thank you!

## Licence

**Free for personal use.** You can install it, modify it and share it, and pull requests are welcome. **Commercial use, use by an educational institution, or selling it or otherwise making money from it needs written permission first.** [Open an issue](https://github.com/jchin14/netBae/issues) to ask. See [LICENSE](LICENSE) for the full terms.
