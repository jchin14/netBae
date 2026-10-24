# Changelog

What's new in each netBae release. Update with `netbae update`, by re-running the install command, or with `docker compose pull && docker compose up -d`.

## Milestones

The main steps so far, with the full details per version below.

| Versions | What arrived |
|---|---|
| 1.1 | First public release: ping, DNS, speedtests and system stats on a dashboard, one-command Linux install |
| 1.2 | macOS and Windows, game servers (Steam & CS2, Fortnite, Discord), a secondary connection |
| 1.3 - 1.4 | ISP tracking with chart markers, route tracing with on-net / direct / IX / transit labels |
| 1.5 | Docker image for x86 and Raspberry Pi, manual speedtests, installer tests on four Linux distros |
| 1.6 | Read-only public dashboard and `netbae tunnel` (Cloudflare, Tailscale), security hardening |
| 1.8 - 1.9 | IPv6 pings and routes, built-in targets in their own file, a database about 40% smaller |
| 1.10 - 1.14 | DNS and CDN test, IPv6 for regions, sortable tables, a day view and comparing ISPs, route change history, charts grouped by category |
| 1.15 | An Update button on the dashboard and weekly automatic updates |
| 1.19 | NixOS support (install command and a Nix flake), Cloudflare Access sign-in for your own dashboard away from home, speedtests that pause the other tests |

## 1.19.6 - 2026-10-24

The test workflows are now part of the public repo.

- Every release and every pull request is now tested automatically on Linux (Debian, Ubuntu, Fedora), macOS, Windows, Docker and NixOS, and the results are on the repo's Actions tab.

## 1.19.5 - 2026-10-24

A setting to choose whether netBae starts at boot, and a click on the version number checks for updates.

- **Start at boot setting:** `[web] start_at_boot = false` stops netBae from starting when the machine boots, so it only runs after `netbae start`. `netbae config`, `start`, `restart` and `netbae update` apply it on Linux, macOS, Windows and NixOS (`services.netbae.startAtBoot` for flake users). In Docker, use the container's restart policy.
- Click the version number on your dashboard to check for updates right away. If a new release is out, it asks whether to install it now; if you're up to date, it opens the release notes as before.
- On a NixOS install made with the install command, the dashboard now says to update with `netbae update` instead of `nix flake update`.

## 1.19.2 - 2026-10-22

`netbae tunnel` on NixOS, and the NixOS install picks a free port when another web server has port 80.

- **`netbae tunnel` on NixOS:** share the public dashboard through Cloudflare (quick, your own domain or a dashboard token) or Tailscale Funnel with the same commands as on other systems. On NixOS it turns the tunnel on in your NixOS configuration and rebuilds. Flake users get `services.netbae.tunnel.cloudflare` and `services.netbae.tunnel.tailscale` options.
- On NixOS, the install command (and `netbae update`) now checks whether another program already uses the dashboard's port. If one does, it moves netBae to the next free port, saves it in the config, opens that port in the firewall and shows it in the dashboard address. Before, netBae moved to another port by itself, but the firewall only allowed the old one.

## 1.19.0 - 2026-10-22

NixOS support, Cloudflare Access sign-in for your own dashboard away from home, speedtests that pause the other tests, live ISP change lines, and fewer false "down" hosts on a busy machine.

- **NixOS support:** the usual install command now works on NixOS too: it adds netBae to your NixOS configuration as a module (in `/etc/nixos`) and rebuilds, and all the `netbae` commands work. There's also a Nix flake with a package and a `services.netbae` module for flake users (unprivileged service with only the capabilities it needs, config written as Nix, optional firewall port). See NixOS in the README.
- **Sign in from anywhere:** sign in on your public address with Cloudflare Access to get your own dashboard there, so one hostname works for visitors and for you away from home. Visitors still see the public view. Set it up with `[public] access_team` and `access_aud` (see the README).
- Pings, DNS checks and traceroutes pause during every speedtest (scheduled, manual, region, global and secondary connection), so the test's traffic no longer shows up as latency spikes and they don't slow the test down. A test waits for any that are already running, then they resume once it's done. The ping and DNS charts have a short gap instead. System stats keep recording.
- A switch to another ISP (e.g. a failover to your backup connection) gets its dashed line on the latency charts within seconds, without reloading the page.
- ISP checks on the System chart are a tick (or a cross when the check failed) in the ISP's colour, one row per connection, instead of a shape per ISP.
- Ping chart categories are easier to use on phones. Tap the arrow on the left (now a bigger target) to open a category, its name to show or hide it, and the rest of its row to pick out its line on the chart (tap again to stop). With a mouse, hovering a category or host does the same.
- A build newer than the latest release shows as `dev1.x.y` in the header and footer instead of `v1.x.y`, so test builds are easy to tell apart.
- The summary bar shows Internet latency before Avg latency.
- ISP change labels close together on a chart stack instead of hiding each other.
- Fixed: fewer false "down" hosts on a busy machine: when 5 or more hosts fail in the same ping round, they're pinged again a second later, so a short stall on the monitoring machine (swapping, a slow disk) no longer shows a whole batch of hosts, router included, as down.
- Fixed: updating from the dashboard's Update button or automatically no longer says the Ookla speedtest CLI is missing, or installs a second copy of it in /usr/local/bin.

## 1.18.5 - 2026-10-19

Fixes the dashboard summary failing to load on IPv6 networks in 1.18.4, and tests the router's DNS over IPv6.

- DNS: the router over IPv6 too (Router v6), and DHCP DNS over IPv4 and IPv6. The router's own IPv6 address (found by its MAC address) is shown as Router v6 instead of DHCP DNS, so DHCP DNS only lists resolvers that really aren't the router, like your ISP's or a Pi-hole.
- Fixed: in 1.18.4 the dashboard's summary (tiles, header and routes) could fail to load on networks with IPv6, because DNS servers that aren't traced (like the router) broke the route lookup.

## 1.18.4 - 2026-10-19

Internet latency to the nearest servers, sortable speedtest tables, click a table row to hide its line, routes to DNS servers, and fan speed.

- **Internet latency** in the summary bar: the latency to the Ookla servers closest to you (a new built-in region, `Nearest`, pinged by default), so it's your connection's own latency wherever you are. It replaces Nearest city, which could only pick from the region list. Existing installs: add `"Nearest"` to `[ping] regions`.
- Melbourne is a built-in region city, and pinged by default. Existing installs keep their own `[ping] regions` list: add `"Melbourne"` to it to see Melbourne as the nearest city.
- Speedtest tables sort by any column: click Down, Up, Ping, Jitter, Loss, Data, Time or the server. The first click puts the best first (fastest, or lowest latency), the second reverses it, the third goes back to the usual order.
- System (Linux): fan speed in RPM, or fan power % where that's all the machine reports, with its history on the System chart.
- Click a host in the table under a latency or DNS chart to hide its line on the chart (the row stays, dimmed); click again to bring it back. Reset view shows them all again.
- The DNS table shows the route to each public DNS server, like the ping table does for sites. Resolvers that aren't already ping targets are traced along with the sites.
- Fixed: on phones and narrow windows, the buttons at the top (Public view, theme, GitHub) overlapped the machine name and ISP. They now move onto their own line.

## 1.18.1 - 2026-10-19

A Show all / Hide all button on the charts.

- Charts have a Show all / Hide all button next to Reset view, to turn every line off or back on at once

## 1.18.0 - 2026-10-19

Not released on its own: these changes shipped in 1.18.1.

DNS and CDN scores by CDN, built-in DNS and CDN lists that update with netBae, network traffic in the system history, and tidier ping charts and summary bar.

- Ping latency: each category's colour sits next to its name above the chart.
- DNS and CDN: resolvers that gave no answer stay at the bottom, whichever column the table is sorted by.
- DNS and CDN: CDN ping 7d sits next to CDN ping and stays in view with it.
- DNS and CDN: the intro says the lowest score is best and no longer runs wider than the ‹ › buttons.
- System history also plots this machine's network traffic, down and up in Mbps, on its own axis.
- The built-in DNS servers, DNS domains and CDN names moved into targets.toml next to the ping targets, so new ones arrive with updates. Add your own with [dns] extra_servers / extra_domains and [cdn] extra_hostnames, and leave built-in ones out with disable. A config that still holds a list netBae shipped switches to the built-in one by itself.
- The public dashboard status moved to the right side of the header.
- On a new install the charts start on the smallest time range that holds all the data so far, instead of a mostly empty default range.
- DNS and CDN: columns are named by CDN (Akamai CDN, Google CDN ...), with Amazon CloudFront, Fastly and Meta added. The resolver, its score, CDN ping and lookup time stay in view while ‹ › scroll through the CDNs.
- Ping latency: each category is on its own row above the chart with its hosts folded away; ▸ opens it, and opening or closing a category above the chart or in the table does both.
- DNS and CDN: each resolver gets a score, its average CDN ping plus its lookup time, and the table is ranked by it.
- The ping and DNS charts zoom so the highest average sits near the top, using more of the chart's height.
- The DNS and CDN table is narrower, with both Akamai names in one Akamai column.
- The 30-day average row of the global speedtests is highlighted like the other averages.
- The Live / Past badge sits next to each chart's title.
- The speedtest table's average row is highlighted.
- Reset view also turns every line back on (categories stay collapsed).
- The summary bar starts with your ISP's logo, ends with this machine's average CPU and memory use over the last 24 hours after a divider (the System tile stays live), and lists packet loss after jitter.
- The summary bar shows the latency to the nearest region city next to the average latency for all hosts.
- The speedtest arrows in the summary bar use the download and upload colours from the speed chart.
- The ISP logo also loads straight from the ISP's own website when DuckDuckGo's icon service can't be reached.
- `netbae update` on Linux and macOS no longer ends with a stray error like `line 101: e]: command not found` (the update itself always worked).
- The ping and DNS charts show the last 24 hours by default, instead of 1 hour and 6 hours.
- Charts always show the whole time range you picked, instead of zooming in when there's only data for part of it.
- With IPv4 + IPv6 chosen, the latency charts show a key next to the dropdown: solid for IPv4, dashed for IPv6, and the IPv6 dashes are longer so they're easier to tell apart.

## 1.17.0 - 2026-10-18

A summary bar, ISP logos, sharing the public dashboard on several hostnames, lighter default pings and easier-to-use charts.

- The latency charts draw a dashed line, labelled e.g. "Superloop → Telstra", wherever your main connection moved to another ISP.
- In a route, a public hop with no announced network is named from its hostname (e.g. "superloop.au") instead of "private / unknown"; only addresses that really are private say "private".
- In the DNS and CDN table, a DNS server that didn't answer for a hostname now ranks below every server that answered them all.
- `netbae tunnel` now confirms a new hostname works even when your router still has an old "no such name" answer cached for it.
- `netbae tunnel` no longer stops right after "Checking for a cloudflared update" on Linux, and `netbae tunnel <hostname>` now works as a shortcut for `netbae tunnel cloudflare <hostname>`.
- `netbae tunnel cloudflare` can share the public dashboard on several hostnames, e.g. `netbae tunnel cloudflare netbae.example.com status.example.org`, or one more each time you run it. `netbae tunnel remove <hostname>` stops sharing on one, and the dashboard header lists every hostname.
- Pings run every 30 seconds by default instead of every 5, and region pings every 60 seconds instead of 30, for a lighter load. Configs that set `interval_seconds` keep their own value.
- The footer says netBae isn't affiliated with any provider or carrier shown.
- Region pings show on the ping chart by default (collapsed into one Regions line) instead of being hidden.
- Pronto is shown as Superloop (its owner), including in older ISP checks and speedtests, and the ISP's logo shows next to its name at the top for well-known providers. netBae fetches the logo itself, so your browser doesn't contact anyone else.
- The README has Docker Compose quick-start instructions.
- The public dashboard footer counts visitors over the last 24 hours instead of the last hour.
- Speedtest history shows 10 tests at a time, with previous / next buttons and a choice of 10, 25, 50 or 100 per page.
- Charts have a Reset view button (default range and zoom, categories collapsed), and the ping chart and the ping groups at the top have Expand all / Collapse all.
- The System chart's right-hand axis and lines now say CPU temperature and CPU load, so it's clear what the numbers are.
- Routes now name the city the destination answered from, e.g. "direct to Cloudflare Melbourne" or "transit via GSL to Giganews Amsterdam".
- A summary bar at the top of the dashboard: hosts up, your own hosts up, ISP uptime over the last 24 hours, average latency (not counting regions), packet loss, jitter, DNS time and the latest speedtest.
- A route trace where no hop answered now shows as an error instead of an empty route, and it's traced again the next time netBae starts. Empty routes saved by earlier versions are retried on the next start too.
- The public dashboard line no longer lists your tunnel twice when another Cloudflare tunnel (for other sites) runs on the same machine.

## 1.16.0 - 2026-10-18

Speedtests that wait for a quiet network, faster charts on a Raspberry Pi, and a first speedtest straight after install.

- A new install runs its first speedtest a few minutes after starting, once the first routes are traced, instead of waiting for the next scheduled one.
- `netbae tunnel` now updates cloudflared to the latest version each time it runs, if it's already installed.
- The bottom of the dashboard lists how often pings and speedtests run (including region, secondary connection and random-city tests), taken from your config.
- Scheduled speedtests now wait while your network is busy (other traffic over 10% of your last result), checking again every 3 minutes. After 30 minutes they run anyway and the result is marked "busy". netBae uses your router's traffic counters when it offers them over UPnP, so it sees every device; otherwise it sees only its own machine's traffic. Run now never waits. Change it with `busy_check`, `busy_percent` and `busy_wait_minutes` under `[speedtest]`.
- Hovering a row in the ping or DNS table highlights that host's line in the chart.
- The DNS and CDN table's "CDN ping" column is now called "Avg CDN ping".
- The ISP check markers moved from the ping, DNS and speedtest charts to the System history chart, so the busy charts stay easier to read.
- The ping and DNS charts load much faster over ranges longer than 2 days (a 7-day chart went from about 1 second to well under a tenth on a test machine, and more on a Raspberry Pi).
- The ping and DNS tables also load about twice as fast for ranges up to 6 hours, with exactly the same numbers.
- Changing the dropdowns on the ping and DNS charts quickly no longer piles up requests or briefly shows an older choice.
- On a Mac, the dashboard's Update button could stop partway through the update. Fixed for updates from this version on.
- Links to your dashboard now show the netBae icon and a preview card in iMessage, Slack and other apps, and adding it to an iPhone home screen gives it a proper icon.
- `netbae update` and the Update button do nothing when the installed version is newer than the latest release, instead of going back to it.
- A security policy (`SECURITY.md`): report security problems privately from the repo's Security tab.

## 1.15.1 - 2026-10-18

Fixes for route tracing on some Linux systems and for `netbae tunnel` on your own domain.

- Fixed routes showing no hops and every route labelled "direct" on Linux systems where `traceroute` is the GNU inetutils version (e.g. Armbian). A trace that fails now shows its error instead of an empty route.
- Fixed `netbae tunnel` stopping at the Cloudflare sign-in for your own domain with "mkdir .../.cloudflared: no such file or directory".
- `netbae tunnel` now uses another port for the public dashboard when its port (8080 by default) is taken by another program, instead of stopping with "the public dashboard didn't come up".
- Running `netbae tunnel` again for your own domain no longer stops with "credentials.json already exists".

## 1.15.0 - 2026-10-18

One-click and automatic updates.

- **Update button:** when a new release is out, the private dashboard's header shows "Update to vX". It runs the same update as `netbae update` (config and history kept) and reloads the page when the new version is running. The dashboard never gets admin rights: it asks a small system job set up by the installer (systemd on Linux, launchd on a Mac, a SYSTEM scheduled task on Windows) that only runs the official update. Docker installs show the new version and the `docker compose pull` command. Turn the release check off with `[web] update_check = false`.
- **Automatic updates:** netBae installs new releases by itself, at most once a week at 3:30 am local time, using the same path as the Update button. Set `[web] auto_update` to `"daily"` or `"off"` to change that. Docker installs don't update themselves.
- When netBae is up to date, the version in the header shows a ✓, and hovering it says when it last checked for a newer release.
- `targets.toml` (the built-in host list) starts with a clear warning not to edit it, since updates replace it, and to use `netbae config` instead.
- DNS and CDN: clearer column names. "Avg ms" is now **CDN ping** (the average ping to the servers a DNS server sent you to, which the ranking uses), "7-day avg" is **CDN ping, 7 days**, and "DNS ms" is **DNS lookup** (how long the DNS server took to answer), with an explanation under the heading and on hover.

## 1.14.0 - 2026-10-18

Charts grouped by category.

- **Charts by category:** the ping chart draws one line per category (Streaming, CDN, Gaming...), the average of the hosts selected in it, and its table has one row per category. Click a row to expand it into each host (and again to collapse). The DNS chart does the same per resolver, with IPv4 and IPv6 together. Far fewer lines to draw, so the page stays light, with every host one click away. All hosts except Regions are selected by default; chart selections start over once.

## 1.13.1 - 2026-10-18

Faster dashboard loading.

- **Lighter page load:** the ping chart starts with 5 lines (Router, ISP first hop, Cloudflare DNS, Google, Netflix) and the DNS chart with 4 resolvers, instead of drawing every host, which used a lot of CPU. Click any host or group to add it; your choice is remembered. Selections saved by earlier versions start over once.

## 1.13.0 - 2026-10-18

Routes record only changes, consistent host colours, and test results in every release.

- **Routes only record changes:** when a trace finds the same route as last time, netBae updates that route's last-seen time and hop timings instead of storing it again, and remembers when the route was first seen. Route details list the route changes with their time spans. Existing repeated entries are merged once on the first start after updating.
- Each host's colour is a square everywhere (tiles, chart toggles and tables), slightly larger on the host tiles, so it's easy to tell apart from the round status dots.
- Route details: "Spotted an issue? Open a GitHub issue."
- Release notes have a CI table: the platforms each release was tested on (Debian 12 and 13, Ubuntu 24.04, Fedora, macOS, Windows, Docker) with the results, and VirusTotal scan results for the release files.
- README: the detail sections all start collapsed.

## 1.12.1 - 2026-10-18

Windows Defender fixes.

- **Windows Defender:** the Windows scripts no longer do the things Defender treats as malware-like. Asking for admin rights re-runs the installer from a readable script file in Temp instead of an encoded command line, `netbae update` downloads the installer to a file instead of piping it into Invoke-Expression, `netbae uninstall` deletes the folder directly instead of from a hidden delayed window, and netBae's own scripts run under the standard RemoteSigned policy instead of Bypass.

## 1.12.0 - 2026-10-18

Look back at any day, compare ISPs, and clearer warnings.

- **Look back at a day:** each chart's time menu has "A day…": pick a date (yesterday by default) and step back and forward with ◀ ▶.
- **Compare ISPs:** once your main connection has been on more than one ISP, the ping and DNS charts get an ISP selector. It keeps only the times you were on that ISP (from the ISP checks), so the averages, P5/P95 and loss are for that provider alone.
- Each chart shows whether it's **Live** or showing past data, and the header says when any chart is on a past range.
- DNS and CDN: a DNS ms column (how long each server took to answer), click any column heading to sort (ascending, descending, back to the ranking), and click anywhere in a cell to see the route. When a server handed out several addresses, that opens a list of every address with its ping, loss and route (all of them are traced).
- Packet loss stands out: orange above 0%, red above 1%, on the tiles and in the ping and DNS tables.
- Hover over a status dot to see why it's orange or red (loss, a lost latest ping or high latency), and which hosts make a group orange or red.
- **"No internet" when your internet was fine:** the ISP check uses ipinfo.io, which rate-limits busy addresses (HTTP 429), and the header then said "no internet". When ipinfo.io refuses, netBae now gets your public address from Cloudflare and the ISP from Team Cymru instead, and a lookup service refusing shows as "ISP lookup failed" rather than "no internet".
- Routes: networks run by the same company count as one ISP, so a Superloop connection whose addresses are registered to Exetel (which Superloop owns) no longer shows every route as transit. The ISP check also names the network that announces your address rather than the company the address block is registered to.
- The Run random, Run regions and secondary connection Run buttons start straight away, without a confirmation popup.
- README: how each release is tested, and the known limitations; the changelog starts with a summary of the main milestones.

## 1.11.0 - 2026-10-18

Sortable latency tables and storage for every drive.

- **Sort the latency tables:** click a column heading in the ping or DNS table (Avg ms, Min, P5, P95, Max, Loss, Samples) to sort the hosts by it. Click again for descending, and a third time to go back to the usual order. Each browser remembers its choice.
- System: storage shows the boot drive and, when there's more than one, all local drives added up (extra partitions, USB and internal disks, ZFS pools; not network shares, RAM disks or snap images). Not in Docker, which only sees the container's own mounts.

## 1.10.0 - 2026-10-18

DNS and CDN test, IPv6 for regions and dashboard improvements.

- **DNS and CDN test:** a new section shows which CDN server each DNS resolver sends you to. Every 30 minutes each resolver looks up `a2.w10.akamai.net`, `a10.w2.akamai.net`, `google.com`, `microsoft.com` and `www.cloudflare.com` (a baseline: Cloudflare's anycast addresses are the same whichever resolver asks), the addresses it hands out are pinged (and traced every 6 hours), and the resolvers are ranked by average latency, with a 7-day average and a Test now button. Settings under `[cdn]`.
- Region pings and routes over IPv6 too: each city is also measured over IPv6, to the same speedtest server when it has IPv6, otherwise the fastest one there that does. Shown like the sites: an IPv6 line on each region tile and the chart's IPv4 / IPv6 / both switch.
- **Run random:** a button next to Run now starts a speedtest to a random server somewhere in the world (a global speedtest) on demand.
- New DNS resolver: Quad9 with ECS (9.9.9.11 and 2620:fe::11), which passes part of your address on so CDNs answer for where you are. If your `config.toml` has its own `[dns] servers` list, add it there.
- New target: Paramount+ (Streaming).
- Click anywhere on a host's tile to open its route.
- The latency charts' spread band is off by default, with a new `[web] chart_band` option (`"none"`, `"p5-p95"` or `"min-max"`). Each browser still remembers its own choice. The band is now only drawn when 12 or fewer lines are showing, since more turn it into a smear; a note says so.
- The dashboard header shows the version, linking to its release notes.
- The browser tab is titled "netBae - Internet Monitor".
- Route text leaves out the destination when it's the site itself: Netflix's route reads "IX via MegaIX Melbourne" rather than "... to Netflix", and Google's just "direct". It still names it when it differs, e.g. ChatGPT "direct to Cloudflare". Direct routes no longer say "direct direct".
- Route details end with a note that hop locations are a best estimate, with a link to report a wrong one.
- Tiles and tables shorten Global Secure Layer to GSL (route details keep the full name).
- Hop locations: a city spelled out in a router's name now wins over a 3-letter code (Bundle-Ether43.lon-edge901.melbourne.telstra.net is Melbourne, not London). Routes traced before the update keep their old locations until they're traced again (every 12 hours).
- README: what on-net, direct, IX and transit mean, with examples.

## 1.9.0 - 2026-10-18

Smaller database, global speedtests and more targets. The first start after updating converts your history to the smaller format once (about 25 seconds per GB).

- **Global speedtests:** after every 5 main speedtests, netBae runs one to a random server in a random city around the world (about 45 cities), shown in a new Global speedtests section and kept out of your own averages. Set how often with `[speedtest] global_every` (`0` = off).
- **Smaller database.** Host names, DNS servers and domains are stored once instead of on every row, raw samples are stored in (host, time) order with one index instead of two, and 1-minute summaries drop two columns the new histograms replace. The ping and DNS history is about 40% smaller: a year with the defaults takes about 2.5 GB instead of 4.2 GB. Existing databases are converted once when netBae starts after the update; on a Pi with months of history this can take a few minutes, and the file is compacted afterwards if there's enough free disk space.
- More default ping targets: your ISP's first hop (the router your connection lands on, usually the BNG, found automatically and rechecked hourly, in Network); a **Calls & chat** group (Slack, Microsoft Teams, Zoom, Webex, Google Meet); and more games (AWS GameLift's nearest region over UDP, Battle.net, Minecraft's Hypixel server).
- Streaming AU: SBS On Demand, 10 and Sky News join ABC iview, 7plus, 9Now, Stan, Foxtel and Kayo.

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
