<div align="center">

# netBae

**A self-hosted dashboard for your home internet connection.**<br>
Ping, DNS, game servers and speedtests, recorded around the clock on a Raspberry Pi, a Linux VM or a Mac.

![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-2f6fe4)
![Python](https://img.shields.io/badge/python-3.8%2B-2f6fe4)
![Dependencies](https://img.shields.io/badge/dependencies-none-1a9e5c)
![License](https://img.shields.io/badge/license-personal%20use-d48806)

<img src="docs/screenshot.png" alt="netBae dashboard" width="900">

</div>

## Why netBae

Your ISP's status page says everything is fine, but your game lagged, the video call dropped and the evening stream buffered. netBae keeps a record of what your connection was actually doing, so you can see when it was slow, how slow and where the problem was.

- **Latency to everything that matters:** your router, DNS resolvers, Google/YouTube, Netflix/Twitch, Facebook/Reddit, Microsoft/Apple/AWS/GitHub, Akamai/Fastly, and **game servers** (Steam & CS2, Fortnite, Discord voice), every 5 seconds
- **Grouped overview:** one card per category with its average ping. Click a card to see every host in it.
- **Charts that show jitter:** the average as a solid line with a shaded P5–P95 (or min–max) band. The y-axis fits the averages, and you can zoom and drag.
- **Speedtests** with the official [Ookla Speedtest CLI](https://www.speedtest.net/apps/cli): download, upload, ping, jitter, packet loss, ISP and data used, with 24-hour and 7-day averages
- **Worldwide view:** latency to 18 cities (London, New York, Tokyo, Singapore …), plus optional speedtests to them
- **Backup connection monitoring:** test a 5G/4G failover link alongside your main connection, at the same time
- **DNS over IPv4 and IPv6:** response times for each resolver and domain
- **History kept forever,** at the right resolution: every ping for 7 days, 1-minute summaries for 90 days, hourly summaries for ever
- **Works from any device** on your network, including when the internet is down
- **No Docker, no dependencies:** Python's standard library and SQLite. One command installs or updates it.

## Quick start

On a Raspberry Pi, a Linux VM (Proxmox, etc.) or a Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/jchin14/netBae/main/install.sh | sudo bash
```

Then open **`http://<that-machine>/`** on your phone or laptop. Run the same command again any time to update; your config and history are kept.

| | Supported |
|---|---|
| **Linux** | Raspberry Pi OS, Debian, Ubuntu, Fedora, RHEL/Rocky/Alma, Arch, openSUSE (systemd) on x86_64, arm64, armhf, armv6, i386 |
| **macOS** | 12 Monterey or later, Apple silicon or Intel (uses Homebrew) |
| **Windows** | Not yet. Run netBae on a Pi or VM and open the dashboard from Windows. |

<details>
<summary><b>What the installer does on Linux</b></summary>

1. installs `python3`, `ping` and `curl` with your package manager
2. installs the official Ookla Speedtest CLI from Ookla's package repository (Debian/Ubuntu/Pi OS, Fedora/RHEL), so it updates with your system, or from Ookla's release tarball elsewhere. The unofficial Python `speedtest-cli` is removed, since it conflicts.
3. creates an unprivileged `netbae` user and installs the app to `/opt/netbae`
4. writes `/etc/netbae/config.toml` (an existing config is never overwritten)
5. starts the `netbae` systemd service on port 80 without running as root (via `CAP_NET_BIND_SERVICE`)
6. opens the port in `ufw`/`firewalld` if either is active, and installs the `netbae` command

On Proxmox, use a VM or a *privileged* LXC container; unprivileged LXC can block ping.
</details>

<details>
<summary><b>What the installer does on macOS</b></summary>

1. uses (or `brew install`s) a Python 3.11+; macOS's own `python3` is too old
2. installs the Ookla CLI from Ookla's Homebrew tap (`teamookla/speedtest`). Homebrew always runs as your user, never as root.
3. creates a hidden `_netbae` user and installs the app to `/usr/local/lib/netbae`
4. writes `/usr/local/etc/netbae/config.toml`
5. starts a launchd LaunchDaemon (`com.github.netbae`) on port 80, so it runs from boot with nobody logged in, still as an unprivileged user
6. allows Python through the macOS firewall if it's on

Tips: stop the Mac from sleeping (System Settings → Energy), and use Ethernet so the charts measure your internet rather than your Wi-Fi. Temperature isn't available on macOS without root.
</details>

<details>
<summary><b>Where things live</b></summary>

| | Linux | macOS |
|---|---|---|
| App | `/opt/netbae` | `/usr/local/lib/netbae` |
| Config | `/etc/netbae/config.toml` | `/usr/local/etc/netbae/config.toml` |
| Database | `/var/lib/netbae/netbae.db` | `/usr/local/var/netbae/netbae.db` |
| Log | `journalctl -u netbae` | `/usr/local/var/log/netbae.log` |
| Service | systemd `netbae.service` | launchd `com.github.netbae` |
</details>

## Everyday use

```bash
netbae update        # update to the latest version (or re-run the install command)
netbae status        # is it running?
netbae logs          # follow the log
netbae config        # edit the config, validate it and restart
netbae check         # validate the config and show the next speedtest times
netbae uninstall     # remove (add --purge to also delete config + history)
```

When an update adds new options or default targets, your config isn't overwritten. The latest defaults are saved next to it as `config.toml.default`.

## Configuration

Everything lives in one commented [config file](config.toml). The highlights:

| Setting | Default | |
|---|---|---|
| `[web] port` | `80` | change it if something else (e.g. a reverse proxy) uses port 80 |
| `[ping] targets` | 21 hosts in 9 groups | `{ name, host, group }`; `host = "gateway"` = your router; `method = "tcp"` for hosts that block ping |
| `[ping] interval_seconds` / `offset_seconds` | `5` / `0` | |
| `[ping] regions` | 18 cities | latency to the fastest Ookla server in each city, every `region_interval_seconds` (30) |
| `[dns] servers` / `domains` | router + Cloudflare, Google, Quad9 over IPv4 and IPv6 / 5 domains | IPv6 servers are skipped automatically on IPv4-only networks |
| `[speedtest] interval_minutes` / `offset_minutes` | `60` / `0` | e.g. `offset_minutes = 6` → runs at :06 every hour |
| `[speedtest] regions` | none | cities to speedtest, e.g. `["Sydney", "Singapore", "London"]`, once a day by default |
| `[storage]` | `7` / `90` / `0` days | raw samples / 1-minute summaries / hourly summaries (`0` = forever) |
| `[[connections]]` | none | extra internet connections to test, see [below](#monitoring-a-backup-connection-5g4g) |

All schedules follow the wall clock (local time), so `interval_minutes = 30` with `offset_minutes = 6` runs at :06 and :36 whenever the service started.

### Game servers

Game companies don't publish servers you can ping, so netBae measures what their own clients use. It picks the server nearest you and shows which one it chose on the tile, e.g. *Sydney (nearest)*.

| Target | What's measured | Pin a region |
|---|---|---|
| `valve:auto` (Steam & CS2) | the nearest [Steam Datagram Relay](https://partner.steamgames.com/doc/features/multiplayer/steamdatagramrelay); CS2 and Dota 2 traffic runs through these | `valve:syd`, `valve:sgp`, `valve:lax`, `valve:fra` … |
| `epic:auto` (Fortnite) | Epic's regional ping beacons, which Fortnite uses to choose a region | `epic:oce`, `naw`, `nac`, `nae`, `eu`, `asia`, `me`, `br` |
| `discord:auto` (Discord voice) | the nearest Discord voice server, from Discord's own latency service | `discord:sydney`, `discord:singapore` … |

**Not possible:** Riot (Valorant, League of Legends) and Activision (Warzone) block ping and connection tests to their game servers, so no tool can measure them from outside the game. Guessed IPs would only give misleading numbers.

### Region speedtests and pings

Built-in cities: 🇦🇺 Sydney, Perth · 🇳🇿 Auckland · 🇸🇬 Singapore · 🇭🇰 Hong Kong · 🇯🇵 Tokyo · 🇬🇺 Guam · 🇮🇳 Delhi · 🇴🇲 Oman · 🇺🇸 Los Angeles, New York · 🇨🇦 Toronto · 🇧🇷 São Paulo · 🇬🇧 London · 🇳🇱 Amsterdam · 🇫🇷 Paris · 🇮🇹 Milan · 🇿🇦 Cape Town.

netBae looks up the Ookla servers in each city, measures them and uses the fastest. It retries the next one if a server fails and refreshes the list daily. Add your own with `{ name = "Frankfurt", city = "Frankfurt", country = "Germany", flag = "DE" }` or `{ name = "Work", server_id = 12345 }`. Ookla has no public servers in mainland China, so Hong Kong is the closest.

Each speedtest can use 0.5–1 GB on a fast connection, so region speedtests are off by default and run daily once enabled. Tests never overlap.

### Monitoring a backup connection (5G/4G)

If your router fails over to a second connection (say NBN to 5G), you can test both at the same time. netBae sends the backup connection's tests from a **second IP address** on the monitoring machine, and your router sends traffic from that IP out of the backup WAN.

**1. Give the machine a second IP address** on your LAN, outside your router's DHCP range:

```bash
# Raspberry Pi OS (bookworm) / NetworkManager
sudo nmcli con mod "Wired connection 1" +ipv4.addresses 192.168.1.51/24 && sudo nmcli con up "Wired connection 1"
```

(netplan: add it under `addresses:`; ifupdown: `up ip addr add 192.168.1.51/24 dev eth0`.)

**2. Route that IP out of the backup WAN on your router.** A normal *static route* matches the destination, but this needs a **source-based (policy) route**: *source 192.168.1.51 → WAN2*. Routers call it Policy Routing (TP-Link Omada, DrayTek), Policy-Based Routes / Traffic Routes (UniFi), a firewall rule with a gateway (pfSense/OPNsense) or a routing mark (MikroTik). If you can, turn off failover for that rule, so the backup tests fail when the backup is down instead of quietly using your main connection.

**Alternative:** plug a second network adapter (USB Ethernet or Wi-Fi) into the 5G modem and use its interface name instead of an IP.

**3. Add the connection** with `netbae config`:

```toml
[[connections]]
name = "5G"
bind = "192.168.1.51"          # or an interface, e.g. "eth1"
targets = ["1.1.1.1", "8.8.8.8", "google.com", "valve:auto"]
speedtest_interval_minutes = 1440   # daily: mobile data isn't free (0 = only when you press Run)
```

The connection gets its own group of ping tiles and its own row in the speedtest table, with its ISP and data used, so you can compare it with your main line.

## How it measures

- **Ping:** one ICMP echo per host per interval, using the system `ping`. Hosts that block ping can use a timed TCP connect instead.
- **Router:** `gateway` reads the default route from the kernel (`/proc/net/route`; `route get default` on macOS), so it follows whatever router you're using.
- **Sites:** each name is pinged at the address it resolves to, which for big services is their nearest edge or CDN server. That's the path your real traffic takes.
- **DNS:** one UDP A-record query per resolver and domain, timed in Python, over IPv4 and IPv6.
- **Speedtests:** the official Ookla CLI, auto-selecting the closest server unless you choose one.
- **System:** the model name comes from the device tree on a Raspberry Pi (`/proc/device-tree/model`), DMI/BIOS info on PCs and VMs, and `sysctl` on a Mac.

## Data storage

History is kept in SQLite at three resolutions:

- every sample for `raw_retention_days` (7)
- 1-minute summaries (count, average, min, max, 5th and 95th percentile) for `minute_retention_days` (90)
- hourly summaries, speedtests and system history for `retention_days` (0 = forever)

Charts automatically use the right one, so a whole year loads instantly even on a Pi. With the defaults, expect a few hundred MB of recent detail plus roughly 30–50 MB per year of long-term history.

## Behind a reverse proxy

netBae works behind Nginx, Caddy, Traefik or Nginx Proxy Manager, on its own hostname or under a sub-path. Caddy:

```
netbae.home.lan {
    reverse_proxy 192.168.1.50:80
}
```

There's no login, so keep it on your LAN. If you need auth, add it at the proxy.

## API

Everything on the dashboard comes from a small JSON API you can use from Home Assistant, Grafana or scripts:
`/api/summary`, `/api/config`, `/api/system`, `/api/system/history`, `/api/ping`, `/api/dns`, `/api/speedtest` (query: `from`, `to` in Unix seconds, plus `targets` / `servers` / `domain`), and `POST /api/speedtest/run?scope=main|regions|conn:<name>`.

## FAQ

**Does it run on Windows?** Not natively yet. Run it on a Raspberry Pi, a Linux VM or a Mac, and open the dashboard from any browser on Windows.

**How much data does it use?** Pings and DNS are tiny (a few MB a day). Speedtests are what count: each uses roughly what your connection can move in about 20 seconds. On a gigabit line that's about 1 GB per test, so hourly tests add up. The dashboard shows data used per test and per day.

**Can I show certain groups expanded, e.g. on a wall display?** Open `http://<machine>/?expand=Gaming,DNS`.

**By running speedtests**, you accept [Ookla's EULA and privacy policy](https://www.speedtest.net/about/eula). netBae passes `--accept-license --accept-gdpr` to the CLI.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). netBae has no build step: edit, run `python3 app/netbae.py -c <your config>`, refresh.

## Licence

**Free for personal use.** You can install it, modify it and share it, and pull requests are welcome. **Commercial use, use by an educational institution, or selling it or otherwise making money from it needs written permission first.** [Open an issue](https://github.com/jchin14/netBae/issues) to ask. See [LICENSE](LICENSE) for the full terms.
