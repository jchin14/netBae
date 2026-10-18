# Security policy

## Supported versions

Only the latest release gets security fixes. Update with `netbae update`, by re-running the install command, or with `docker compose pull && docker compose up -d`. netBae also updates itself once a week by default (`[web] auto_update`).

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately instead:

1. Go to the [Security tab](https://github.com/jchin14/netBae/security) of this repo.
2. Click **Report a vulnerability** and describe what you found: the version, your platform (Linux, macOS, Windows or Docker), the steps to reproduce it and what an attacker could do with it.

You'll get a reply within 7 days. Once a fix is released, the changelog will say what was fixed, and you'll be credited unless you'd rather not be.

## What's in scope

- **The public dashboard** (port 8080, `[public]`): anything that leaks what it's meant to hide (your addresses, hostname, city, hops inside your network, your own domains), starts a speedtest or trace, changes anything, or gets around the rate limits.
- **The update mechanism**: the dashboard's Update button, the root/SYSTEM update job and automatic updates, for example a way to make them run something other than the official update.
- **The installers and `netbae` command**: anything that lets a local user or the netBae service account gain root or admin rights.
- **`netbae tunnel`**: anything that exposes the private dashboard (port 80) to the internet.
- Code injection through config values, target names, DNS answers, traceroute output or speedtest results.

## What's not in scope

- **The private dashboard has no login, by design.** It's meant for your own network only, so anyone who can reach port 80 can see everything and press the Run and Update buttons. If you need a login, put it behind a [reverse proxy](README.md#behind-a-reverse-proxy) with authentication, and use the [public dashboard](README.md#sharing-a-public-dashboard) to share it.
- Problems in third-party software netBae uses (Python, the Ookla speedtest CLI, cloudflared, Tailscale, Chart.js). Report those to their own projects.
- Denial of service through sheer traffic volume from many machines.
