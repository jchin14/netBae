# Changelog

What's new in each netBae release. Update with `netbae update`, by re-running the install command, or with `docker compose pull && docker compose up -d`.

## 1.8.0 - 2026-10-18

IPv6, more targets and route locations.

- **IPv4 and IPv6:** when your network has IPv6, every site is also pinged and traced over IPv6, as a separate line. Tiles show both, and the ping chart has an IPv4 / IPv6 / both switch (IPv6 dashed). Sites without IPv6 are skipped, and IPv4 history carries on as before. Turn it off with `[ping] ipv6 = false` or `[traceroute] ipv6 = false`.
- **Ping targets have their own file.** The built-in list is now `targets.toml`, which is updated with netBae, so new default targets (like the ones below) arrive by themselves. In `config.toml`, `[ping] extra_targets` adds your own hosts and `[ping] disable` switches built-in ones off by name or group. Configs from earlier versions list every target under `[ping] targets`, which still works and replaces the built-in list: delete it and move your own hosts to `extra_targets` to get the new defaults.
- More default ping targets: Atlassian; a **Hosting** group that measures real data centres rather than the providers' websites (AWS and Oracle Cloud in Sydney, OVHcloud and Vultr in Sydney, DigitalOcean and Linode in Singapore, Hetzner in Falkenstein, and the Azure portal), with the hostnames for other regions in `targets.toml`; Disney+, HBO Max and TikTok; a **Streaming AU** group (Stan, ABC iview, 7plus, 9Now, Foxtel, Kayo); and a **China cloud & CDN** group (Alibaba Cloud, Tencent Cloud, Huawei Cloud, Baidu, ByteDance's BytePlus, CDNetworks).
- Routes show which cities they pass through ("Through Melbourne → Sydney → Los Angeles"), with a location for every hop: from the router's name where it has a city code, otherwise approximate IP geolocation that's checked against the hop's response time. With `[public] show_city = false`, the public dashboard leaves out each route's first city (yours) and the names of the routers there.
- **Accurate P5/P95 over long ranges.** Charts and tables covering more than about 6 hours used to show the average of each minute's lowest and highest ping as P5/P95, which made P95 too high (several times too high on a spiky connection). Summaries now keep a latency histogram, so P5/P95 are within a few percent over any range. This applies to data recorded from this version on; the database grows by about a third for the 1-minute summaries.
- The speedtest card says how long until the next scheduled run, e.g. "Sat 1:06 PM (in 2 h 14 min)".
- The Avg ms column in the ping and DNS tables stands out (highlighted, larger and bold).
- Clicking "ISP checks" above a chart shows or hides all ISP markers at once.
- The install and update message mentions `netbae tunnel` for sharing a read-only dashboard.
- README: an Uninstall section for every platform, including Docker.
- Fixed three built-in ping targets whose hostnames didn't exist (always 100% loss): UsenetExpress (`news.usenetexpress.com`), OVHcloud Sydney and DigitalOcean Singapore. If your `config.toml` still has its own `[ping] targets` list from before 1.8, change `usnews.usenetexpress.com` to `news.usenetexpress.com` there.

## 1.7.0 - 2026-10-17

Manual speedtests and easier Docker setup.

- New `[speedtest] manual` option (on by default): the dashboard's Run buttons now work even when scheduled speedtests are off (`enabled = false`). Set `manual = false` too to turn speedtests off completely.
- Buy me a coffee link in the README and on the dashboard.
- README: copying an install command copies only the command, without a comment line, and the command list is now a table.
- README: the Docker `docker run` command keeps the config and history in a `netbae-data` folder (was a Docker volume), so you can edit `netbae-data/config.toml` directly, as with Docker Compose.

## 1.6.1 - 2026-10-17

Security hardening.

- Requests from other websites can't start speedtests (checked with `Sec-Fetch-Site`/`Origin`, works behind reverse proxies).
- The public dashboard never shows internal error details.
- Time ranges in API requests must be valid numbers.
- Chart.js downloads are checked against a known SHA-256 hash in the Linux/macOS and Windows installers and the Docker image, and by Subresource Integrity in the browser fallback.

## 1.6.0 - 2026-10-17

Public dashboard and tunnels.

- **Public dashboard:** an optional read-only copy of the dashboard on a second port (`[public]` in the config), for sharing. Visitors can look but can't run anything, requests are rate-limited, and private details are hidden: your IP addresses (including every IPv6 prefix you've had), your own domains, hops inside your network, this machine's name and, optionally, your city (`show_city`, `show_hostname`, plus your own `hide` list).
- **`netbae tunnel`:** shares the public dashboard through Cloudflare Tunnel (quick tunnel, your own domain, or a dashboard token) or Tailscale Funnel without opening ports on your router. Works on Linux, macOS and Windows.
- The private dashboard shows the tunnel's status, whether it's reachable, and visitor counts, and warns when visitors bypass the tunnel.
- The dashboard listens on IPv6 as well as IPv4.
- If the configured port is taken, the installers move only the `[web]` port.
- README: TL;DR, contents and a full config reference.

## 1.5.0 - 2026-10-17

Docker, more targets and route labels.

- **Docker image** `ghcr.io/jchin14/netbae` for amd64, arm64 and arm/v7 (Raspberry Pi), with the Ookla CLI built in, plus a `docker-compose.yml`. The dashboard warns when Docker's bridge network would skew results.
- **Theme switch** in the header: Auto (follows your device), Light or Dark.
- Each hand-over on a route is labelled **peering**, **paid transit** or **to customer** (from CAIDA's AS-relationship data). A route whose first hand-over is at an internet exchange counts as IX.
- New targets: Usenet split into US (Omicron/Newshosting, Easynews, Giganews, UsenetExpress, Frugal) and EU (Eweka, Usenet.Farm), an AI group (ChatGPT, Claude, Grok), and Instagram.
- New targets get a route traced soon after startup instead of waiting for the next 12-hour run.
- Charts zoom the time axis to the data when it fills less than half the chosen range.
- If port 80 (or your chosen port) is taken, netBae uses the next free port; the installers save it in the config.
- Fixes: macOS installs failing when `/usr/local/var/log` already existed with strict permissions; a leftover netBae process holding the port; `netbae logs` permissions on macOS; Fedora installing an unrelated "speedtest" package, and missing `runuser`/`hostname` on minimal Fedora.

## 1.4.1 - 2026-10-16

- Routes tell a **direct** interconnect from an **internet exchange** hand-over, using PeeringDB's exchange prefixes.
- A secondary connection can ping every main target with `targets = "all"`.

## 1.4.0 - 2026-10-16

Route tracing.

- Traces a route to every target every 12 hours and labels it **on-net**, **direct**, **IX** or **transit**, with the carriers along the way.
- Route details show each hop's hostname, latency and network.
- Outlier-trimmed averages, so one bad sample doesn't skew a chart.
- New targets: X, CDNs (Cloudflare, CloudFront, Azure Front Door, Bunny, Gcore) and Usenet providers.
- netBae logo, GitHub link and credit in the header and footer.
- Click anywhere on a group card (except a host tile) to expand it; chart tooltips only list lines near the cursor.

## 1.3.0 - 2026-10-16

- **ISP tracking** for each connection, with markers on the charts when your ISP changes (a different shape per ISP, toggled from the legend).
- More DNS resolvers: OpenDNS, CleanBrowsing, AdGuard, NextDNS and Control D (IPv4 and IPv6), your router, and the DNS servers your network hands out.
- macOS secondary connections can bind to a network interface.

## 1.2.1 - 2026-10-15

- "Backup/5G connection" is now called **secondary connection**.
- Windows: secondary connections bind to a source IP address.
- Fixed the README screenshot.

## 1.2.0 - 2026-10-15

macOS, Windows and games.

- **macOS** (launchd service) and **Windows** (scheduled task, `netbae.cmd`) support.
- **Game servers:** Steam/CS2, Fortnite and Discord voice, nearest or a chosen region.
- **Secondary connections:** test a second internet connection alongside your main one.
- IPv6 DNS, history kept forever by default, speedtest ISP, jitter, packet loss and data used, panning on the charts' y-axis, and flags on region results.
- Groups can be opened directly with `?expand=`.

## 1.1.0 - 2026-10-15

First public release.

- Pings (router, DNS providers, popular sites), DNS response times, hourly Ookla speedtests and system stats (uptime, load, CPU, RAM, storage) on a dashboard reachable from any device on your network.
- Targets grouped by category, with region pings and speedtests to 18 cities.
- Chart filters, time ranges, percentile bands and y-axis zoom.
- One-command installer for any Linux machine with systemd, and the `netbae` command (status, logs, update, config).
