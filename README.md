# netBae

A self-hosted dashboard for monitoring your internet connection. It runs on a Raspberry Pi, a Proxmox VM or any other systemd-based Linux machine. No Docker is required.

- **Ping latency and packet loss** every 5 s to your router (auto-detected), Cloudflare/Google/Quad9 DNS and popular sites and CDNs (Google, Microsoft, Facebook, Reddit, Discord, Netflix, Steam, Akamai, Fastly)
- Latency charts draw the **average** as a solid line with a shaded **P5–P95** (or min–max) band, so you can see jitter and spikes. The y-axis fits the averages automatically, and there are zoom buttons.
- **DNS response times** for each resolver and domain
- **Speedtests** with the [official Ookla Speedtest CLI](https://www.speedtest.net/apps/cli) (hourly by default, with automatic server selection), showing the latest result plus 24 h and 7 day averages
- Optional **region speedtests** to cities worldwide (London, New York, Tokyo, Singapore, Sydney …) on their own schedule
- **System stats**: uptime, load, CPU, RAM, storage, temperature, plus history
- Every chart has its own host filter and time range: 15 min to 30 days, or a custom date range
- Open `http://<machine>/` from your phone or laptop. It keeps working when the internet is down (assets are served locally)
- Standard-library Python plus SQLite, so there are no pip packages or containers

<!-- Add a screenshot: docs/screenshot.png -->

## Install

On the machine that will run the monitor:

```bash
curl -fsSL https://raw.githubusercontent.com/jchin14/netBae/main/install.sh | sudo bash
```

Or from a clone:

```bash
git clone https://github.com/jchin14/netBae.git && sudo bash netBae/install.sh
```

Then open **`http://<machine-ip>/`** on any device on your network.

**Supported:** Raspberry Pi OS, Debian, Ubuntu, Fedora, RHEL/Rocky/Alma, Arch and openSUSE, on x86_64, arm64, armhf, armv6 or i386. The installer:

1. installs `python3`, `ping` and `curl` with your package manager
2. installs the **official Ookla Speedtest CLI**:
   - Debian/Ubuntu/Raspberry Pi OS and Fedora/RHEL use Ookla's official package repository (`packagecloud.io/ookla/speedtest-cli`), so it updates with `apt upgrade` / `dnf upgrade`
   - other distros and ARMv6 use Ookla's official release tarball from `install.speedtest.net`
   - the unofficial Python `speedtest-cli` package is removed if present, since Ookla's CLI conflicts with it
3. creates an unprivileged `netbae` system user and installs the app to `/opt/netbae`
4. writes `/etc/netbae/config.toml` (an existing config is never overwritten)
5. installs and starts the `netbae` systemd service on **port 80** (allowed via `CAP_NET_BIND_SERVICE`, so it doesn't run as root)
6. opens the port in `ufw` or `firewalld` if either is active

**Updating:** run `netbae update`, or just run the install command again. It detects the existing install, updates to the latest version and keeps your config and data. When new options or default targets are added, your config isn't overwritten: compare it with `/etc/netbae/config.toml.default`. If port 80 is already in use (for example by a reverse proxy on the same machine), the installer stops and tells you which program has it. Set `[web] port` to something else and re-run.

> **Proxmox tip:** use a VM or a *privileged* LXC container. Unprivileged LXC can block ICMP ping.

## Configuration

Edit `/etc/netbae/config.toml`, then run `sudo systemctl restart netbae`.

| Setting | Default | |
|---|---|---|
| `[web] port` | 80 | |
| `[ping] targets` | `gateway`, 1.1.1.1, 8.8.8.8, 9.9.9.9, google, microsoft, facebook, reddit, discord, www.netflix.com, steampowered, akamai, fastly | `gateway` = auto-detected router; `method = "tcp"` + `port` for hosts that block ping (e.g. amazon.com, netflix.com) |
| `[ping] interval_seconds` / `offset_seconds` | 5 / 0 | |
| `[dns] servers` / `domains` | gateway + 3 public resolvers / google, microsoft, facebook, reddit, netflix | every server is queried for every domain |
| `[dns] interval_seconds` | 30 | |
| `[speedtest] interval_minutes` / `offset_minutes` | 60 / 0 | |
| `[speedtest] servers` | `[]` (auto) | server IDs from `speedtest -L`; each listed server is tested on every run, one after another |
| `[speedtest] regions` | `[]` | cities to test against, e.g. `["Sydney", "Singapore", "London"]` (see below) |
| `[speedtest] regions_interval_minutes` / `regions_offset_minutes` | 1440 / 30 | region tests run once a day at 00:30 by default |
| `[storage] raw_retention_days` | 7 | full-resolution samples |
| `[storage] retention_days` | 30 | 1-minute summaries (count, avg, min, max, p5, p95), speedtests and system history |

### Region speedtests

Built-in regions: London, New York, Tokyo, Amsterdam, Singapore, Sydney, Auckland, Los Angeles, Hong Kong, Milan, Paris, Oman, Delhi, Guam, Perth, São Paulo, Cape Town and Toronto. netBae finds Ookla servers in that city (using the same server search speedtest.net uses), tries up to three if one fails, and refreshes the list daily. You can also add your own:

```toml
regions = ["Sydney", "Singapore", { name = "Frankfurt", city = "Frankfurt", country = "Germany" }, { name = "Work", server_id = 12345 }]
```

Tests never overlap: the main test and each region run one after another. Each test can use 0.5–1 GB on a fast connection, so keep region tests infrequent. Ookla has no public servers in mainland China; Hong Kong is the closest.

### Offsets

All schedules follow the wall clock, not the service start time, and the offset shifts that schedule:

- `interval_minutes = 60`, `offset_minutes = 6` → speedtest at 00:06, 01:06, 02:06 …
- `interval_minutes = 30`, `offset_minutes = 6` → :06 and :36 every hour
- `interval_seconds = 5`, `offset_seconds = 2` → pings at :02, :07, :12 …

Check your config and the next speedtest times with `netbae check`.

## Behind a reverse proxy

netBae works behind Nginx, Caddy, Traefik or Nginx Proxy Manager, either on its own hostname or under a sub-path (strip the prefix). Caddy examples:

```
netbae.home.lan {
    reverse_proxy 192.168.1.50:80
}

home.lan {
    handle_path /netbae/* {
        reverse_proxy 192.168.1.50:80
    }
}
```

## Useful commands

```bash
netbae update        # update to the latest version
netbae status        # service status
netbae logs          # follow the log
netbae config        # edit the config, validate it and restart
netbae check         # validate the config, show next speedtest times
netbae uninstall     # remove (add --purge to delete config + data)
speedtest -L         # list nearby Ookla server IDs
```

## How it measures

- **Router:** `host = "gateway"` reads the default route from the kernel routing table (`/proc/net/route`, the same as `ip route`) at startup, so it follows whatever router your machine uses.
- **Sites:** each host is pinged at the IP its name resolves to. For big sites that's their nearest **edge/CDN server**, not a distant origin: reddit.com and fastly.com are Fastly, discord.com is Cloudflare, www.netflix.com is Netflix's own edge network, steampowered.com and akamai.com are Akamai, and google.com, microsoft.com and facebook.com are those companies' own edge networks. That measures the path your traffic to those services actually takes.
- **DNS:** a single UDP A-record query to each resolver, timed in Python.

## API

`/api/summary`, `/api/system`, `/api/config`, `/api/ping?from=&to=&targets=`,
`/api/dns?from=&to=&servers=&domain=`, `/api/speedtest?from=&to=`,
`/api/system/history?from=&to=`, `POST /api/speedtest/run`. Times are Unix seconds.

## Notes

- There is no login. It's meant for a trusted LAN, so don't expose it to the internet. If you need auth, put it behind a reverse proxy that adds it.
- DNS timings come from resolver caches, which matches what your devices actually experience.
- Hourly speedtests use roughly 0.5–1 GB a day on a fast connection.
- By running speedtests you accept [Ookla's EULA and privacy policy](https://www.speedtest.net/about/eula). netBae passes `--accept-license --accept-gdpr` to the CLI.

## Data storage

Samples go into SQLite at `/var/lib/netbae/netbae.db`. Every minute they're summarised into a 1-minute table (count, average, min, max, 5th and 95th percentile). Charts covering more than about 8 hours read the summaries, so 30-day views stay fast on a Pi. Raw 5-second samples are deleted after `raw_retention_days`. With the default 13 targets, expect a few hundred MB.

## Development

```bash
python3 app/netbae.py -c config.toml -v   # set a writable [storage] database path and a free [web] port first
```

Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Free for personal use: install it, modify it and share it, and pull requests are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md)). **Commercial use, use by an educational institution, selling it or otherwise making money from it needs written permission first.** [Open an issue](https://github.com/jchin14/netBae/issues) to ask. See [LICENSE](LICENSE) for the full terms.
