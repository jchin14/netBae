# netBae

A self-hosted dashboard for monitoring your internet connection. It runs on a Raspberry Pi, a Proxmox VM or any other systemd-based Linux machine. No Docker is required.

- **Ping latency and packet loss** to your router (auto-detected), public DNS servers and websites, every 5 s
- **DNS response times** for each resolver and domain
- **Speedtests** with the [official Ookla Speedtest CLI](https://www.speedtest.net/apps/cli) (hourly by default, with automatic server selection)
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

Re-running the installer upgrades in place and keeps your config and data. If port 80 is already in use (for example by a reverse proxy on the same machine), the installer stops and tells you which program has it. Set `[web] port` to something else and re-run.

> **Proxmox tip:** use a VM or a *privileged* LXC container. Unprivileged LXC can block ICMP ping.

## Configuration

Edit `/etc/netbae/config.toml`, then run `sudo systemctl restart netbae`.

| Setting | Default | |
|---|---|---|
| `[web] port` | 80 | |
| `[ping] targets` | `gateway`, 1.1.1.1, 8.8.8.8, 9.9.9.9, microsoft.com, facebook.com | `gateway` = auto-detected router; `method = "tcp"` + `port` for hosts that block ping |
| `[ping] interval_seconds` / `offset_seconds` | 5 / 0 | |
| `[dns] servers` / `domains` | gateway + 3 public resolvers / google, microsoft, facebook | every server is queried for every domain |
| `[dns] interval_seconds` | 30 | |
| `[speedtest] interval_minutes` / `offset_minutes` | 60 / 0 | |
| `[speedtest] servers` | `[]` (auto) | server IDs from `speedtest -L`; each listed server is tested on every run |
| `[storage] retention_days` | 30 | |

### Offsets

All schedules follow the wall clock, not the service start time, and the offset shifts that schedule:

- `interval_minutes = 60`, `offset_minutes = 6` → speedtest at 00:06, 01:06, 02:06 …
- `interval_minutes = 30`, `offset_minutes = 6` → :06 and :36 every hour
- `interval_seconds = 5`, `offset_seconds = 2` → pings at :02, :07, :12 …

Check your config and the next speedtest time with:

```bash
sudo -u netbae python3 /opt/netbae/netbae.py -c /etc/netbae/config.toml --check-config
```

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
systemctl status netbae          # service status
journalctl -u netbae -f          # live logs
sudo systemctl restart netbae    # apply config changes
speedtest -L                     # list nearby Ookla server IDs
sudo bash /opt/netbae/uninstall.sh [--purge]
```

## API

`/api/summary`, `/api/system`, `/api/config`, `/api/ping?from=&to=&targets=`,
`/api/dns?from=&to=&servers=&domain=`, `/api/speedtest?from=&to=`,
`/api/system/history?from=&to=`, `POST /api/speedtest/run`. Times are Unix seconds.

## Notes

- There is no login. It's meant for a trusted LAN, so don't expose it to the internet. If you need auth, put it behind a reverse proxy that adds it.
- DNS timings come from resolver caches, which matches what your devices actually experience.
- Hourly speedtests use roughly 0.5–1 GB a day on a fast connection.
- By running speedtests you accept [Ookla's EULA and privacy policy](https://www.speedtest.net/about/eula). netBae passes `--accept-license --accept-gdpr` to the CLI.

## Development

```bash
python3 app/netbae.py -c config.toml -v   # needs a writable [storage] database path and a free [web] port
bash build-installer.sh                   # dist/netbae-installer.sh, a single self-extracting installer
```

CI (`.github/workflows/ci.yml`) runs shellcheck, a smoke test and the installer build on every push, and attaches `netbae-installer.sh` to GitHub releases.

## License

MIT
