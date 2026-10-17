#!/usr/bin/env python3
"""netBae - lightweight internet connection monitor.

Collects ping latency, DNS response times, Ookla speedtests and system stats
into SQLite and serves a dashboard + JSON API. Python standard library only.
"""
import argparse
import copy
import glob
import ctypes
import ctypes.util
import ipaddress
import http.client
import json
import ssl
import logging
import logging.handlers
import math
import os
import platform
import random
import shutil
import re
import socket
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        tomllib = None

log = logging.getLogger("netbae")
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
VERSION = "1.8.0"
REPO_URL = "https://github.com/jchin14/netBae"
IS_MAC = sys.platform == "darwin"
IS_WINDOWS = sys.platform == "win32"
# Windows keeps config, database and log together in %ProgramData%\netBae.
WIN_DATA_DIR = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "netBae")
DEFAULT_CONFIG_PATH = os.path.join(WIN_DATA_DIR, "config.toml") if IS_WINDOWS else "/etc/netbae/config.toml"
# Don't flash a console window for each ping when running outside a console. Children start in the Windows
# folder, not the data folder: a tracert still running after netBae is stopped would block deleting it.
SUBPROCESS_FLAGS = {"creationflags": subprocess.CREATE_NO_WINDOW,
                    "cwd": os.environ.get("SystemRoot", r"C:\Windows")} if IS_WINDOWS else {}

# Popular public resolvers: (name, IPv4, IPv6). NextDNS and Control D answer without an account.
PUBLIC_RESOLVERS = [
    ("Cloudflare", "1.1.1.1", "2606:4700:4700::1111"),
    ("Google", "8.8.8.8", "2001:4860:4860::8888"),
    ("Quad9", "9.9.9.9", "2620:fe::fe"),
    ("OpenDNS", "208.67.222.222", "2620:119:35::35"),
    ("CleanBrowsing", "185.228.168.9", "2a0d:2a00:1::2"),
    ("AdGuard", "94.140.14.14", "2a10:50c0::ad1:ff"),
    ("NextDNS", "45.90.28.0", "2a07:a8c0::"),
    ("Control D", "76.76.2.0", "2606:1a40::"),
]

# IPv6 address of a public resolver's IPv4 address, so pings to 1.1.1.1 get an IPv6 twin too
V6_TWIN = {v4: v6 for _, v4, v6 in PUBLIC_RESOLVERS}

TARGETS_FILE = os.path.join(HERE, "targets.toml")
# used only if targets.toml is missing or unreadable
FALLBACK_TARGETS = [{"name": "Router", "host": "gateway", "group": "Network"},
                    {"name": "Cloudflare DNS", "host": "1.1.1.1", "group": "DNS"},
                    {"name": "Google DNS", "host": "8.8.8.8", "group": "DNS"},
                    {"name": "Google", "host": "google.com", "group": "Google"}]


def load_builtin_targets(path=TARGETS_FILE):
    """netBae's own ping targets, shipped (and replaced on every update) as targets.toml next to this file."""
    try:
        if tomllib is None:
            raise OSError("Python 3.11+ (or the 'tomli' package) is needed to read it")
        with open(path, "rb") as f:
            targets = tomllib.load(f)["targets"]
        if not isinstance(targets, list):
            raise ValueError("'targets' isn't a list")
        return targets
    except (OSError, ValueError, KeyError) as e:
        log.warning("couldn't read the built-in targets from %s (%s); using a minimal list", path, e)
        return list(FALLBACK_TARGETS)


BUILTIN_TARGETS = load_builtin_targets()

DEFAULT_CONFIG = {
    "web": {"host": "0.0.0.0", "port": 80},
    # optional read-only copy of the dashboard for sharing (e.g. through a Cloudflare Tunnel)
    "public": {"enabled": False, "host": "0.0.0.0", "port": 8080,
               "requests_per_minute": 120, "total_requests_per_minute": 1200, "hide": [],
               "show_hostname": False, "show_city": True},
    # raw samples -> 1-minute summaries -> hourly summaries; 0 = keep forever
    "storage": {"database": os.path.join(WIN_DATA_DIR, "netbae.db") if IS_WINDOWS else "/var/lib/netbae/netbae.db",
                "raw_retention_days": 7, "minute_retention_days": 90, "retention_days": 0},
    "ping": {
        "interval_seconds": 5,
        "offset_seconds": 0,
        "timeout_seconds": 2,
        "targets": BUILTIN_TARGETS,  # from targets.toml; config.toml adds extra_targets and disable
        "extra_targets": [],
        "disable": [],
        # Latency to the fastest Ookla speedtest server in each region (TCP connect), shown as a "Regions" group.
        "regions": ["Sydney", "Perth", "Auckland", "Singapore", "Hong Kong", "Tokyo", "Guam", "Delhi", "Oman",
                    "Los Angeles", "Toronto", "New York", "São Paulo", "London", "Amsterdam", "Paris", "Milan",
                    "Cape Town"],
        "region_interval_seconds": 30,
        # also ping each site over IPv6 (stored separately) when this machine and the site have IPv6
        "ipv6": True,
    },
    "dns": {
        "enabled": True,
        "interval_seconds": 30,
        "offset_seconds": 0,
        "timeout_seconds": 2,
        "servers": [
            {"name": "Router", "host": "gateway"},
            {"name": "DHCP DNS", "host": "dhcp"},  # resolvers this machine got from DHCP, if not the router
        ] + [{"name": name, "host": ip} for name, v4, v6 in PUBLIC_RESOLVERS for ip in (v4, v6)],
        "domains": ["google.com", "microsoft.com", "facebook.com", "reddit.com", "netflix.com"],
    },
    "speedtest": {
        "enabled": True,
        "manual": True,
        "interval_minutes": 60,
        "offset_minutes": 0,
        "servers": [],
        "regions": [],
        "regions_interval_minutes": 1440,
        "regions_offset_minutes": 30,
        "binary": "auto",
        "timeout_seconds": 300,
    },
    "system": {"interval_seconds": 30, "offset_seconds": 0, "disk_path": "/"},
    # public IP + ISP of the main connection and every secondary connection (shows failovers)
    "isp": {"enabled": True, "interval_minutes": 10, "offset_minutes": 0, "main_name": "Main"},
    # route to every target every 12 h: which networks (ASNs) carry it - on-net, peering or transit
    "traceroute": {"enabled": True, "interval_hours": 12, "offset_minutes": 15, "max_hops": 25, "parallel": 6,
                   "ipv6": True},  # also trace IPv6 routes to the sites pinged over IPv6
    # extra internet connections tested through a different source IP or interface (e.g. a secondary 5G/4G WAN)
    "connections": [],
}


# --------------------------------------------------------------------------- config

def default_gateway():
    """IPv4 default gateway, read from the kernel routing table."""
    raw = read_file("/proc/net/route")
    if raw:
        for line in raw.splitlines()[1:]:
            f = line.split()
            if len(f) > 2 and f[1] == "00000000" and f[2] != "00000000":
                return socket.inet_ntoa(struct.pack("<L", int(f[2], 16)))
    if IS_WINDOWS:
        return windows_default_gateway()
    try:  # macOS / BSD
        out = subprocess.run(["/sbin/route", "-n", "get", "default"], capture_output=True, text=True,
                             timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"gateway:\s*(\S+)", out)
    if not m:  # e.g. a VPN that routes everything through an interface with no gateway address
        return None
    try:
        return str(ipaddress.IPv4Address(m.group(1)))
    except ValueError:  # "link#12" and the like
        return None


def docker_bridge():
    """True when running in a container on Docker's bridge network (not network_mode: host)."""
    if not os.environ.get("NETBAE_DOCKER"):
        return False
    try:
        ifaces = [i for i in os.listdir("/sys/class/net") if i != "lo"]
    except OSError:
        return False
    for i in ifaces:
        # a real NIC links to itself (iflink == ifindex); a bridged container only has a veth (linked to
        # an interface outside) and the kernel's placeholder tunnel devices (iflink 0)
        idx, link = read_file(f"/sys/class/net/{i}/ifindex"), read_file(f"/sys/class/net/{i}/iflink")
        if idx and idx == link:
            return False
    return True


def system_dns_servers():
    """The DNS servers this machine uses (normally handed out by DHCP), loopback stubs excluded."""
    found = []
    try:
        if IS_WINDOWS:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-DnsClientServerAddress | ForEach-Object { $_.ServerAddresses }"],
                capture_output=True, text=True, timeout=20, **SUBPROCESS_FLAGS).stdout
            found = out.split()
        else:
            # systemd-resolved keeps the real upstream servers here; /etc/resolv.conf may only list 127.0.0.53
            for path in ("/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"):
                raw = read_file(path)
                if raw:
                    found = [ln.split()[1] for ln in raw.splitlines() if ln.startswith("nameserver") and len(ln.split()) > 1]
                    if found:
                        break
    except (OSError, subprocess.SubprocessError):
        return []
    out = []
    for ip in found:
        ip = ip.split("%")[0]  # drop IPv6 zone ids (fe80::1%eth0)
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if not (a.is_loopback or a.is_unspecified or a.is_link_local) and ip not in out:
            out.append(ip)
    return out


def windows_default_gateway():
    """Lowest-metric 0.0.0.0/0 route from `route print`. Its columns are the same in every
    language: destination, netmask, gateway ("On-link" when there is none), interface, metric."""
    best = None
    for line in (run_cmd(["route", "print", "-4", "0.0.0.0"]) or "").splitlines():
        f = line.split()
        if len(f) == 5 and f[0] == "0.0.0.0" and f[1] == "0.0.0.0" and f[4].isdigit():
            try:
                gw = str(ipaddress.IPv4Address(f[2]))
            except ValueError:
                continue
            if gw != "0.0.0.0" and (best is None or int(f[4]) < best[0]):
                best = (int(f[4]), gw)
    return best[1] if best else None


def normalize_target(t, default_port=443):
    if isinstance(t, str):
        t = {"host": t}
    host = str(t["host"]).strip()
    is_gateway = host.lower() == "gateway"
    if is_gateway:
        host = default_gateway() or "gateway"
        if host == "gateway":
            log.warning("could not detect the default gateway; set the router's IP in the config")
    provider, _, pref = host.partition(":")
    if provider.lower() in GAME_PROVIDERS and not is_gateway:
        # nearest game/voice server, found at runtime: "valve:auto", "epic:oce", "discord:sydney" ...
        return {"id": host.lower(), "name": t.get("name") or GAME_PROVIDERS[provider.lower()], "host": host.lower(),
                "method": "game", "port": None, "group": str(t.get("group") or "Gaming"),
                "provider": provider.lower(), "pref": (pref or "auto").lower()}
    method = str(t.get("method", "icmp")).lower()
    if method not in ("icmp", "tcp"):
        raise ValueError(f"target {host}: method must be 'icmp' or 'tcp'")
    port = int(t.get("port", default_port))
    tid = "gateway" if is_gateway else host
    if method == "tcp":
        tid = f"tcp://{tid}:{port}"
    name = t.get("name") or host
    if method == "tcp" and "name" not in t:
        name = f"{host}:{port} (TCP)"
    return {"id": tid, "name": name, "host": host, "method": method, "port": port,
            "group": str(t.get("group") or "Other")}


# --------------------------------------------------------------------------- game / voice servers
# Game companies don't publish ping targets, so these use what their own clients use:
#   valve   - Steam Datagram Relay POPs (Steam, CS2, Dota 2 traffic goes through these relays)
#   epic    - Epic's regional ping beacons (Fortnite region selection)
#   discord - Discord's RTC latency service, which lists the nearest voice servers
GAME_PROVIDERS = {"valve": "Steam & CS2", "epic": "Fortnite", "discord": "Discord voice"}
EPIC_REGIONS = {"oce": "Oceania", "naw": "NA West", "nac": "NA Central", "nae": "NA East", "eu": "Europe",
                "asia": "Asia", "me": "Middle East", "br": "Brazil"}


def http_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": f"netBae/{VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def nearest(candidates, probe):
    """Pick the candidate with the lowest probe() latency (probes run in parallel)."""
    with ThreadPoolExecutor(max_workers=16) as pool:
        times = list(pool.map(probe, candidates))
    ranked = sorted((t, i) for i, t in enumerate(times) if t is not None)
    return candidates[ranked[0][1]] if ranked else None


def resolve_game_server(provider, pref="auto", bind=None):
    """-> {host, port, method, label} for the game/voice server to measure, or None."""
    if provider == "discord":
        regions = [r for r in http_json("https://latency.discord.media/rtc") if r.get("ips")]
        region = next((r for r in regions if pref in ("auto", r["region"])), None)
        if region:  # the service lists the nearest voice regions first; voice servers answer on TCP 443
            return {"host": region["ips"][0], "port": 443, "method": "tcp", "label": region["region"].title()}
        return None
    if provider == "valve":
        pops = {k: v for k, v in http_json(
            "https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730")["pops"].items()
            if v.get("relays") and v["relays"][0].get("ipv4")}
        code = pref if pref in pops else nearest(sorted(pops), lambda k: icmp_ping(pops[k]["relays"][0]["ipv4"], 1, bind))
        if not code:
            return None
        return {"host": pops[code]["relays"][0]["ipv4"], "port": None, "method": "icmp",
                "label": pops[code].get("desc") or code}
    if provider == "epic":
        code = pref if pref in EPIC_REGIONS else nearest(
            list(EPIC_REGIONS), lambda k: icmp_ping(f"ping-{k}.ds.on.epicgames.com", 2, bind))
        if not code:
            return None
        return {"host": f"ping-{code}.ds.on.epicgames.com", "port": None, "method": "icmp", "label": EPIC_REGIONS[code]}
    return None


# --------------------------------------------------------------------------- connections

def normalize_connection(c, all_targets=None):
    """A secondary internet connection (e.g. a 5G/4G WAN) measured through its own source IP or interface."""
    if not isinstance(c, dict) or not c.get("name") or not c.get("bind"):
        raise SystemExit("[[connections]] entries need a name and a bind (source IP or interface name)")
    name, bind = str(c["name"]), str(c["bind"])
    try:
        ipaddress.ip_address(bind)
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", bind):
            raise SystemExit(f"connection {name}: bind must be an IP address or interface name")
        if IS_WINDOWS:  # no SO_BINDTODEVICE, and Windows ping only takes a source address (-S)
            raise SystemExit(f"connection {name}: on Windows, bind must be this PC's source IP address, not {bind!r}")
    targets = []
    wanted = c.get("targets") or ["1.1.1.1", "8.8.8.8", "google.com"]
    if wanted == "all":  # mirror every main ping target over this connection
        wanted = [dict(t) for t in (all_targets or []) if str(t.get("host") if isinstance(t, dict) else t) != "gateway"]
    for t in wanted:
        t = normalize_target(t)
        targets.append(dict(t, id=f"{name}|{t['id']}", group=name, bind=bind, connection=name))
    return {"name": name, "bind": bind, "targets": targets,
            "speedtest": bool(c.get("speedtest", True)),
            "speedtest_interval_minutes": float(c.get("speedtest_interval_minutes", 1440)),
            "speedtest_offset_minutes": float(c.get("speedtest_offset_minutes", 45))}


# Built-in speedtest regions: name -> (Ookla search term, server city name or None for any, country).
# Ookla has no public servers in mainland China; Hong Kong is the closest.
REGIONS = {
    "London": ("London", "London", "United Kingdom"),
    "New York": ("New York", "New York, NY", "United States"),
    "Tokyo": ("Tokyo", "Tokyo", "Japan"),
    "Amsterdam": ("Amsterdam", "Amsterdam", "Netherlands"),
    "Singapore": ("Singapore", "Singapore", "Singapore"),
    "Sydney": ("Sydney", "Sydney", "Australia"),
    "Auckland": ("Auckland", "Auckland", "New Zealand"),
    "Los Angeles": ("Los Angeles", "Los Angeles, CA", "United States"),
    "Hong Kong": ("Hong Kong", "Hong Kong", "Hong Kong"),
    "Milan": ("Milan", "Milan", "Italy"),
    "Paris": ("Paris", "Paris", "France"),
    "Oman": ("Muscat", "Muscat", "Oman"),
    "Delhi": ("New Delhi", "New Delhi", "India"),
    "Guam": ("Guam", None, "Guam"),
    "Perth": ("Perth", "Perth", "Australia"),
    "São Paulo": ("São Paulo", "São Paulo", "Brazil"),
    "Cape Town": ("Cape Town", "Cape Town", "South Africa"),
    "Toronto": ("Toronto", "Toronto, ON", "Canada"),
}
REGION_FLAGS = {"London": "GB", "New York": "US", "Tokyo": "JP", "Amsterdam": "NL", "Singapore": "SG",
                "Sydney": "AU", "Auckland": "NZ", "Los Angeles": "US", "Hong Kong": "HK", "Milan": "IT", "Paris": "FR",
                "Oman": "OM", "Delhi": "IN", "Guam": "GU", "Perth": "AU", "São Paulo": "BR", "Cape Town": "ZA",
                "Toronto": "CA"}
REGION_ALIASES = {"sao paulo": "São Paulo", "new delhi": "Delhi", "muscat": "Oman", "milano": "Milan",
                  "nyc": "New York", "la": "Los Angeles", "hk": "Hong Kong"}
OOKLA_SEARCH = "https://www.speedtest.net/api/js/servers?engine=js&limit=100&https_functional=true&search="


def normalize_region(r):
    """A region is a built-in name ("Tokyo"), {name, city, country} or {name, server_id}."""
    if isinstance(r, dict):
        if "server_id" in r:
            return {"name": r.get("name") or f"Server {r['server_id']}", "server_id": int(r["server_id"]),
                    "flag": str(r.get("flag", "")).upper()}
        if not r.get("city") or not r.get("country"):
            raise SystemExit(f"[speedtest] region {r!r} needs city and country (or server_id)")
        return {"name": r.get("name") or r["city"], "search": r.get("search") or r["city"],
                "city": r["city"], "country": r["country"], "flag": str(r.get("flag", "")).upper()}
    key = str(r).strip()
    name = REGION_ALIASES.get(key.lower()) or next((n for n in REGIONS if n.lower() == key.lower()), None)
    if name is None:
        hint = " (Ookla has no public servers in mainland China - try Hong Kong)" if key.lower() in (
            "beijing", "shanghai", "china") else ""
        log.warning("unknown speedtest region %r skipped%s. Built-in regions: %s", key, hint, ", ".join(REGIONS))
        return None
    search, city, country = REGIONS[name]
    return {"name": name, "search": search, "city": city, "country": country, "flag": REGION_FLAGS.get(name, "")}


def find_region_servers(region):
    """Ookla servers in a region as [{id, host, port, ms}], fastest (by TCP connect) first."""
    if region.get("server_id"):
        return [{"id": region["server_id"], "host": None, "port": None, "ms": None}]
    req = urllib.request.Request(OOKLA_SEARCH + urllib.parse.quote(region["search"]),
                                 headers={"User-Agent": f"netBae/{VERSION}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        servers = json.load(r)
    city = (region.get("city") or "").lower()
    found = []
    for x in servers:
        if str(x.get("country", "")).lower() != region["country"].lower():
            continue
        if city and x["name"].lower() != city and not x["name"].lower().startswith(city + ","):
            continue
        host, _, port = str(x.get("host", "")).rpartition(":")
        found.append({"id": int(x["id"]), "host": host or None, "port": int(port) if port.isdigit() else 8080})
        if len(found) == 6:
            break
    # the first search result isn't always the best server: measure and sort, unreachable last
    # (a hostname that hangs in DNS shouldn't stall the lookup: give up on stragglers after 8 s)
    pool = ThreadPoolExecutor(max_workers=6)
    futures = [pool.submit(tcp_ping, c["host"], c["port"], 3) if c["host"] else None for c in found]
    wait([f for f in futures if f], timeout=8)
    pool.shutdown(wait=False)
    for c, f in zip(found, futures):
        c["ms"] = f.result() if f and f.done() else None
    return sorted(found, key=lambda c: (c["ms"] is None, c["ms"] or 0))


def windows_speedtest_paths():
    """Where install.ps1 puts speedtest.exe: winget (machine or user scope) or Ookla's zip."""
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    local = os.environ.get("LOCALAPPDATA", "")
    found = [os.path.join(pf, "netBae", "speedtest", "speedtest.exe"),
             os.path.join(pf, "WinGet", "Links", "speedtest.exe")]
    found += sorted(glob.glob(os.path.join(pf, "WinGet", "Packages", "Ookla.Speedtest.CLI*", "speedtest.exe")))
    if local:
        found += [os.path.join(local, "Microsoft", "WinGet", "Links", "speedtest.exe")]
        found += sorted(glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages",
                                               "Ookla.Speedtest.CLI*", "speedtest.exe")))
    return found


def find_speedtest(binary):
    """Resolve 'auto' to the Ookla CLI: /usr/bin (official package), /usr/local/bin (tarball),
    Homebrew on macOS, or winget / the netBae program folder on Windows."""
    if binary and binary != "auto":
        return binary
    cands = windows_speedtest_paths() if IS_WINDOWS else \
        ["/usr/bin/speedtest", "/usr/local/bin/speedtest", "/opt/homebrew/bin/speedtest"]
    for cand in cands + [shutil.which("speedtest")]:
        if cand and os.access(cand, os.X_OK):
            return cand
    return "speedtest"


def merge_targets(ping):
    """(raw, normalized) ping targets: the built-in or listed targets, minus [ping] disable (names or groups),
    plus [ping] extra_targets (one with the same host, method and port replaces the built-in one)."""
    off = {str(x).strip().lower() for x in ping.get("disable") or []}
    pairs, used = [], set()
    for t in ping["targets"]:
        n = normalize_target(t)
        hit = {n["name"].lower(), n["group"].lower()} & off
        used |= hit
        if not hit:
            pairs.append((t, n))
    for t in ping.get("extra_targets") or []:
        n = normalize_target(t)
        same = [i for i, (_, x) in enumerate(pairs) if x["id"] == n["id"]]
        if same:
            pairs[same[0]] = (t, n)
        else:
            pairs.append((t, n))
    for name in sorted(off - used):
        log.warning("[ping] disable: no built-in target or group called %r", name)
    return [t for t, _ in pairs], [n for _, n in pairs]


def load_config(path):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if os.path.exists(path):
        if tomllib is None:
            raise SystemExit("Python 3.11+ (or the 'tomli' package) is required to read the config file")
        with open(path, "rb") as f:
            user = tomllib.load(f)
        if "targets" in (user.get("ping") or {}):  # a full list of its own (configs from before 1.8 have one)
            log.info("config.toml has its own [ping] targets, so the built-in list in targets.toml isn't used. Delete "
                     "targets to get the built-in list (updated with netBae) and put your own hosts in extra_targets.")
        for section, values in user.items():
            if isinstance(values, dict):
                cfg.setdefault(section, {}).update(values)
            elif section == "connections" and isinstance(values, list):
                cfg["connections"] = values
    else:
        log.warning("config %s not found, using built-in defaults", path)

    raw_targets, ping_targets = merge_targets(cfg["ping"])
    cfg["ping"]["targets"] = ping_targets
    cfg["ping"]["regions"] = [r for r in map(normalize_region, cfg["ping"]["regions"]) if r]
    for r in cfg["ping"]["regions"]:
        cfg["ping"]["targets"].append({"id": f"region:{r['name']}", "name": r["name"], "host": None,
                                       "method": "region", "port": None, "group": "Regions", "region": r,
                                       "flag": r["flag"]})
    cfg["connections"] = [normalize_connection(c, raw_targets) for c in cfg["connections"]]
    for c in cfg["connections"]:
        cfg["ping"]["targets"].extend(c["targets"])
    if cfg["ping"]["ipv6"]:
        # Sites on the main connection are measured over IPv4 and IPv6 separately: the IPv6 twin's id is "<id>#v6".
        # Not the router, game/region servers or secondary connections (bound to an IPv4 source address).
        for t in list(cfg["ping"]["targets"]):
            if t["method"] in ("icmp", "tcp") and not t.get("bind") and t["id"] != "gateway" and ":" not in t["host"] \
                    and (not is_ip(t["host"]) or t["host"] in V6_TWIN):
                t["family"] = 4
                cfg["ping"]["targets"].append(dict(t, id=t["id"] + "#v6", name=f'{t["name"]} (IPv6)', family=6,
                                                   twin=t["id"]))
    servers = []
    for t in cfg["dns"]["servers"]:
        if isinstance(t, dict) and str(t.get("host", "")).lower() == "dhcp":
            # add the DHCP-provided resolvers that aren't the router or already in the list
            gw = default_gateway()
            listed = {str(x.get("host") if isinstance(x, dict) else x) for x in cfg["dns"]["servers"]}
            extra = [ip for ip in system_dns_servers() if ip != gw and ip not in listed]
            for i, ip in enumerate(extra):
                servers.append(dict(normalize_target({"name": t.get("name") or "DHCP DNS", "host": ip}),
                                    id="dhcp" if i == 0 else f"dhcp-{i + 1}"))
            if not extra:
                log.info("DHCP DNS: this machine uses the router (or a listed resolver) for DNS, nothing extra to test")
        else:
            servers.append(normalize_target(t))
    cfg["dns"]["servers"] = servers
    for s in cfg["dns"]["servers"]:
        s["id"] = s["id"].replace("tcp://", "").rsplit(":", 1)[0] if s["method"] == "tcp" else s["id"]
        s["dhcp"] = s["id"].startswith("dhcp")
        s["family"] = 6 if ":" in s["host"] else 4
        s["group"] = f"IPv{s['family']}"
    st = cfg["storage"]
    if float(st["retention_days"]) > 0:  # never keep finer data longer than the overall retention
        st["minute_retention_days"] = min(float(st["minute_retention_days"]), float(st["retention_days"]))
    cfg["speedtest"]["binary"] = find_speedtest(cfg["speedtest"]["binary"])
    cfg["speedtest"]["servers"] = [int(s) for s in cfg["speedtest"]["servers"]]
    cfg["speedtest"]["regions"] = [r for r in map(normalize_region, cfg["speedtest"]["regions"]) if r]

    ids = [t["id"] for t in cfg["ping"]["targets"]]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate ping targets in config")
    for sec, key in (("ping", "interval_seconds"), ("ping", "region_interval_seconds"), ("dns", "interval_seconds"),
                     ("system", "interval_seconds"), ("speedtest", "interval_minutes"),
                     ("speedtest", "regions_interval_minutes")):
        if float(cfg[sec][key]) <= 0:
            raise SystemExit(f"[{sec}] {key} must be > 0")
    return cfg


# --------------------------------------------------------------------------- scheduling

def next_aligned(interval, offset, now=None):
    """Next wall-clock (local time) instant where (t - offset) is a multiple of interval.

    e.g. interval=3600, offset=360 -> runs at hh:06:00 every hour;
         interval=1800, offset=360 -> hh:06 and hh:36.
    """
    now = time.time() if now is None else now
    lt = time.localtime(now)
    utcoff = lt.tm_gmtoff
    local = now + utcoff
    n = math.floor((local - offset) / interval) + 1
    return n * interval + offset - utcoff


def run_aligned(name, interval, offset, fn):
    def loop():
        while True:
            due = next_aligned(interval, offset)
            while True:
                remaining = due - time.time()
                if remaining <= 0:
                    break
                time.sleep(min(remaining, 30))
            try:
                fn()
            except Exception:
                log.exception("%s collector failed", name)
    threading.Thread(target=loop, name=name, daemon=True).start()


# --------------------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS ping (ts REAL NOT NULL, target TEXT NOT NULL, rtt REAL);
CREATE INDEX IF NOT EXISTS ping_target_ts ON ping(target, ts);
CREATE INDEX IF NOT EXISTS ping_ts ON ping(ts);
CREATE TABLE IF NOT EXISTS dns (ts REAL NOT NULL, server TEXT NOT NULL, domain TEXT NOT NULL, ms REAL);
CREATE INDEX IF NOT EXISTS dns_server_ts ON dns(server, ts);
CREATE INDEX IF NOT EXISTS dns_ts ON dns(ts);
CREATE TABLE IF NOT EXISTS speedtest (
    ts REAL NOT NULL, server_id INTEGER, server_name TEXT, server_location TEXT, isp TEXT,
    ping_ms REAL, jitter_ms REAL, download_mbps REAL, upload_mbps REAL, packet_loss REAL,
    result_url TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS speedtest_ts ON speedtest(ts);
CREATE TABLE IF NOT EXISTS system (ts REAL NOT NULL, cpu REAL, mem REAL, disk REAL, temp REAL, load1 REAL);
CREATE TABLE IF NOT EXISTS isp (ts REAL NOT NULL, connection TEXT NOT NULL, ip TEXT, isp TEXT, asn TEXT,
    location TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS isp_ts ON isp(ts);
CREATE TABLE IF NOT EXISTS traceroute (ts REAL NOT NULL, target TEXT NOT NULL, dest TEXT, kind TEXT,
    path TEXT, hops TEXT, error TEXT, dest_host TEXT);
CREATE INDEX IF NOT EXISTS traceroute_target_ts ON traceroute(target, ts);
CREATE TABLE IF NOT EXISTS own_prefix (prefix TEXT PRIMARY KEY, first_seen REAL, last_seen REAL);
CREATE TABLE IF NOT EXISTS hop_geo (ip TEXT PRIMARY KEY, ts REAL, city TEXT, lat REAL, lon REAL);
CREATE INDEX IF NOT EXISTS system_ts ON system(ts);
CREATE TABLE IF NOT EXISTS ping_1m (
    target TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL,
    h0 INTEGER, h1 INTEGER, h2 INTEGER, h3 INTEGER, h4 INTEGER, h5 INTEGER, h6 INTEGER, h7 INTEGER,
    h8 INTEGER, h9 INTEGER, h10 INTEGER, h11 INTEGER, PRIMARY KEY (target, ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ping_1m_ts ON ping_1m(ts);
CREATE TABLE IF NOT EXISTS dns_1m (
    server TEXT NOT NULL, domain TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL,
    h0 INTEGER, h1 INTEGER, h2 INTEGER, h3 INTEGER, h4 INTEGER, h5 INTEGER, h6 INTEGER, h7 INTEGER,
    h8 INTEGER, h9 INTEGER, h10 INTEGER, h11 INTEGER, PRIMARY KEY (server, domain, ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS dns_1m_ts ON dns_1m(ts);
CREATE TABLE IF NOT EXISTS ping_1h (
    target TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL,
    h0 INTEGER, h1 INTEGER, h2 INTEGER, h3 INTEGER, h4 INTEGER, h5 INTEGER, h6 INTEGER, h7 INTEGER,
    h8 INTEGER, h9 INTEGER, h10 INTEGER, h11 INTEGER, PRIMARY KEY (target, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dns_1h (
    server TEXT NOT NULL, domain TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL,
    h0 INTEGER, h1 INTEGER, h2 INTEGER, h3 INTEGER, h4 INTEGER, h5 INTEGER, h6 INTEGER, h7 INTEGER,
    h8 INTEGER, h9 INTEGER, h10 INTEGER, h11 INTEGER, PRIMARY KEY (server, domain, ts)) WITHOUT ROWID;
"""

# Raw samples are summarised into 1-minute rows (count, avg, min, max, p5, p95) so long
# ranges stay fast and raw data can be dropped after raw_retention_days.
SERIES = {
    "ping": {"raw": "ping", "rollup": "ping_1m", "hourly": "ping_1h", "keys": ["target"], "val": "rtt"},
    "dns": {"raw": "dns", "rollup": "dns_1m", "hourly": "dns_1h", "keys": ["server", "domain"], "val": "ms"},
}
ROLLUP_ABOVE_SECONDS = 6 * 3600  # whole-range stats longer than this come from the 1-minute table


# Averages ignore the fastest and slowest 5% of samples once there are at least 10, so a few
# spikes don't drag the average around (min, max and P95 still show them).
TRIMMED_AVG = "AVG(CASE WHEN cnt < 10 OR (rn > 0.05 * cnt AND rn <= 0.95 * cnt) THEN v END)"

# Latency histograms make P5/P95 exact enough over any range: percentiles of 1-minute summaries can't be
# combined, but histograms can be added up. Each summary row counts its samples in 48 bins spaced
# evenly on a log scale from 0.3 ms to 1 s (each bin 18% wider than the last; slower samples go in the
# last bin). Four 16-bit counts are packed into each of the columns h0..h11, and SQLite adds them up
# field by field, so long ranges stay fast and each row grows by ~20 bytes.
HIST_BINS, HIST_LO, HIST_HI = 48, 0.3, 1000.0
HIST_EDGES = [HIST_LO * (HIST_HI / HIST_LO) ** (i / HIST_BINS) for i in range(HIST_BINS + 1)]
HIST_COLS = [f"h{i}" for i in range(HIST_BINS // 4)]
HIST_BIN_SQL = ("CASE WHEN v IS NULL THEN NULL "
                + " ".join(f"WHEN v < {HIST_EDGES[i + 1]!r} THEN {i}" for i in range(HIST_BINS - 1))
                + f" ELSE {HIST_BINS - 1} END")
# packed columns from raw samples (inner query provides hb = bin number)
HIST_FROM_RAW = ", ".join(
    f"NULLIF(SUM(CASE hb WHEN {4 * j} THEN 1 WHEN {4 * j + 1} THEN 65536 WHEN {4 * j + 2} THEN 4294967296"
    f" WHEN {4 * j + 3} THEN 281474976710656 ELSE 0 END), 0)" for j in range(len(HIST_COLS)))
# packed columns added up from summary rows (an hour holds at most 3600 samples per bin, well under 65536)
HIST_COMBINE = ", ".join(
    "NULLIF(" + " + ".join(f"COALESCE(SUM((h{j} >> {16 * k}) & 65535), 0) * {65536 ** k}" for k in range(4)) + ", 0)"
    for j in range(len(HIST_COLS)))
# the 48 bin counts, unpacked, for reading percentiles
HIST_SUMS = ", ".join(f"SUM((h{j} >> {16 * k}) & 65535)" for j in range(len(HIST_COLS)) for k in range(4))


def hist_percentile(counts, p, mn, mx):
    """Nearest-rank percentile from bin counts, placed linearly within its bin and kept within min..max."""
    total = sum(counts)
    k, cum = max(1, math.ceil(p * total)), 0
    for i, c in enumerate(counts):
        if c and cum + c >= k:
            lo, hi = max(HIST_EDGES[i], mn), min(HIST_EDGES[i + 1], mx) if i < HIST_BINS - 1 else mx
            return lo if hi <= lo else lo + (hi - lo) * (k - cum - 0.5) / c
        cum += c
    return None


def trimmed_mean(values):
    v = sorted(x for x in values if x is not None)
    if len(v) >= 10:
        v = v[int(len(v) * 0.05):len(v) - int(len(v) * 0.05)]
    return sum(v) / len(v) if v else None


def outlier_free(values):
    """Drop values outside Tukey's fences (1.5x the interquartile range) when there are enough to judge."""
    v = sorted(x for x in values if x is not None)
    if len(v) < 5:
        return v
    q1, q3 = v[len(v) // 4], v[(3 * len(v)) // 4]
    lo, hi = q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)
    return [x for x in v if lo <= x <= hi]


def pct_select(val, bucket_expr, keys, table, where, hist=False):
    """Per-bucket count/ok/avg/min/max/p5/p95 from raw samples (nearest-rank percentiles), plus the
    packed histogram columns if hist."""
    part = ", ".join(keys + [bucket_expr])
    return (
        f"SELECT {', '.join(keys)}, b, COUNT(*), COUNT(v), {TRIMMED_AVG}, MIN(v), MAX(v),"
        f" MIN(CASE WHEN rn >= 0.05 * cnt THEN v END), MIN(CASE WHEN rn >= 0.95 * cnt THEN v END)"
        + (f", {HIST_FROM_RAW}" if hist else "") +
        f" FROM (SELECT {', '.join(keys)}, b, v, rn, cnt"
        + (f", {HIST_BIN_SQL} AS hb" if hist else "") +
        f" FROM (SELECT {', '.join(keys)}, {bucket_expr} AS b, {val} AS v,"
        f"   ROW_NUMBER() OVER (PARTITION BY {part} ORDER BY {val} IS NULL, {val}) AS rn,"
        f"   COUNT({val}) OVER (PARTITION BY {part}) AS cnt"
        f"   FROM {table} WHERE {where}))"
        f" GROUP BY {', '.join(keys)}, b")


COMBINE = ("SUM(n), SUM(ok), SUM(avg * ok) / NULLIF(SUM(ok), 0), MIN(mn), MAX(mx),"
           " SUM(p5 * ok) / NULLIF(SUM(ok), 0), SUM(p95 * ok) / NULLIF(SUM(ok), 0)")


def rollup_hourly(db, spec, frm, to):
    keys = ", ".join(spec["keys"])
    db.conn().execute(
        f"INSERT OR REPLACE INTO {spec['hourly']} ({keys}, ts, n, ok, avg, mn, mx, p5, p95, {', '.join(HIST_COLS)})"
        f" SELECT {keys}, CAST(ts / 3600 AS INTEGER) * 3600 AS h, {COMBINE}, {HIST_COMBINE}"
        f" FROM {spec['rollup']} WHERE ts >= ? AND ts < ? GROUP BY {keys}, h", (frm, to))


def rollup(db, spec, frm, to):
    keys = spec["keys"]
    sql = pct_select(spec["val"], "CAST(ts / 60 AS INTEGER) * 60", keys, spec["raw"], "ts >= ? AND ts < ?", hist=True)
    db.conn().execute(
        f"INSERT OR REPLACE INTO {spec['rollup']} ({', '.join(keys)}, ts, n, ok, avg, mn, mx, p5, p95,"
        f" {', '.join(HIST_COLS)}) {sql}",
        (frm, to))


class DB:
    def __init__(self, path):
        self.path = path
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        self.local = threading.local()
        self.conn().executescript(SCHEMA)
        cols = {r[1] for r in self.query("PRAGMA table_info(speedtest)")}
        for col, typ in (("kind", "TEXT"), ("label", "TEXT"), ("data_bytes", "INTEGER"),
                         ("server_host", "TEXT")):  # added in 1.1-1.4
            if col not in cols:
                self.conn().execute(f"ALTER TABLE speedtest ADD COLUMN {col} {typ}")
        for t in ("ping_1m", "dns_1m", "ping_1h", "dns_1h"):  # latency histograms, added in 1.8
            have = {r[1] for r in self.query(f"PRAGMA table_info({t})")}
            for col in HIST_COLS:
                if col not in have:
                    self.conn().execute(f"ALTER TABLE {t} ADD COLUMN {col} INTEGER")
        if "dest_host" not in {r[1] for r in self.query("PRAGMA table_info(traceroute)")}:  # added in 1.4
            self.conn().execute("ALTER TABLE traceroute ADD COLUMN dest_host TEXT")
        # since 1.4.2 a route whose first hand-over is at an exchange counts as IX, even if transit follows
        for rid, path in self.query("SELECT rowid, path FROM traceroute WHERE kind = 'transit'"
                                    " AND path LIKE '%\"ixp\": true%'"):
            hops = json.loads(path or "[]")
            if len(hops) > 1 and hops[1].get("ixp"):
                self.conn().execute("UPDATE traceroute SET kind = 'ix' WHERE rowid = ?", (rid,))

    def conn(self):
        c = getattr(self.local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            self.local.c = c
        return c

    def query(self, sql, params=()):
        return self.conn().execute(sql, params).fetchall()

    def scalar(self, sql, params=()):
        row = self.conn().execute(sql, params).fetchone()
        return row[0] if row else None

    def insert_many(self, sql, rows):
        if not rows:
            return
        c = self.conn()
        c.execute("BEGIN")
        try:
            c.executemany(sql, rows)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise


# --------------------------------------------------------------------------- probes

SKIP = object()  # "no measurement this tick" (e.g. server not resolved yet)

PING_RE = re.compile(r"time[=<]\s*([\d.]+)\s*ms")
# Windows translates "time" (Zeit=12ms, temps=12 ms, tiempo<1ms ...) but always prints "=12ms" or "<1ms",
# and nothing else on a reply line ends in "ms".
WIN_PING_RE = re.compile(r"[=<]\s*(\d+)\s*ms\b")


def is_ip(v):
    try:
        ipaddress.ip_address(v)
        return True
    except ValueError:
        return False


def bind_socket(s, bind):
    """Send from a specific source IP, or out of a specific interface (Linux, macOS)."""
    if not bind:
        return
    if is_ip(bind):
        s.bind((bind, 0))
    elif IS_MAC:  # IP_BOUND_IF / IPV6_BOUND_IF take the interface index
        v6 = s.family == socket.AF_INET6
        s.setsockopt(socket.IPPROTO_IPV6 if v6 else socket.IPPROTO_IP, 125 if v6 else 25, socket.if_nametoindex(bind))
    else:
        s.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_BINDTODEVICE", 25), bind.encode())


class _BoundHTTPS(http.client.HTTPSConnection):
    """HTTPS connection sent from a specific source IP or interface."""

    def __init__(self, host, bind, timeout):
        super().__init__(host, timeout=timeout)
        self._bind = bind

    def connect(self):
        family = socket.AF_INET if self._bind and is_ip(self._bind) and ":" not in self._bind else 0
        fam, st, pr, _, addr = socket.getaddrinfo(self.host, self.port, family, socket.SOCK_STREAM)[0]
        sock = socket.socket(fam, st, pr)
        sock.settimeout(self.timeout)
        try:
            bind_socket(sock, self._bind)
            sock.connect(addr)
        except OSError:
            sock.close()
            raise
        self.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.host)


def lookup_isp(bind=None, timeout=10):
    """Public IP, ISP and ASN as seen by ipinfo.io, sent through the given connection."""
    conn = _BoundHTTPS("ipinfo.io", bind, timeout)
    try:
        conn.request("GET", "/json", headers={"User-Agent": f"netBae/{VERSION}", "Accept": "application/json"})
        r = conn.getresponse()
        if r.status != 200:
            raise OSError(f"ipinfo.io returned HTTP {r.status}")
        d = json.loads(r.read())
    finally:
        conn.close()
    org = d.get("org") or ""
    asn, _, name = org.partition(" ") if org.startswith("AS") else ("", "", org)
    loc = ", ".join(x for x in (d.get("city"), d.get("country")) if x)
    return {"ip": d.get("ip"), "isp": name or None, "asn": asn or None, "location": loc or None}


def icmp_ping(host, timeout, bind=None):
    t = str(max(1, math.ceil(timeout)))
    if IS_WINDOWS:  # -S picks the source address; Windows ping can't bind to an interface by name
        cmd = ["ping", "-n", "1", "-w", str(max(1, int(timeout * 1000)))] + (["-S", bind] if is_ip(bind) else [])
    elif IS_MAC:
        if ":" in host:  # macOS ping is IPv4-only; ping6 has no -t timeout
            cmd = ["ping6", "-n", "-c", "1"] + ((["-S", bind] if is_ip(bind) else ["-B", bind]) if bind else [])
        else:
            cmd = ["ping", "-n", "-c", "1", "-t", t] + ((["-S", bind] if is_ip(bind) else ["-b", bind]) if bind else [])
    else:  # older iputils need ping6 for IPv6 addresses; newer ones still ship it as an alias
        exe = "ping6" if ":" in host and shutil.which("ping6") else "ping"
        cmd = [exe, "-n", "-c", "1", "-W", t] + (["-I", bind] if bind else [])
    cmd.append(host)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=timeout + 5,
                             **SUBPROCESS_FLAGS).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None
    m = (WIN_PING_RE if IS_WINDOWS else PING_RE).search(out)
    return float(m.group(1)) if m else None


def tcp_ping(host, port, timeout, bind=None):
    family = socket.AF_INET if bind and is_ip(bind) and ":" not in bind else 0
    try:
        family, stype, proto, _, addr = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)[0]
    except OSError:
        return None
    s = socket.socket(family, stype, proto)
    s.settimeout(timeout)
    try:
        bind_socket(s, bind)
        t0 = time.perf_counter()
        s.connect(addr)
        return (time.perf_counter() - t0) * 1000
    except OSError:
        return None
    finally:
        s.close()


# --------------------------------------------------------------------------- routes (traceroute + ASNs)

# Short names for well-known networks; anything else uses a cleaned-up registry name.
AS_NAMES = {
    174: "Cogent", 1299: "Arelion", 2907: "SINET", 4436: "GTT", 13030: "Init7", 3303: "Swisscom", 3356: "Lumen", 3257: "GTT", 2914: "NTT", 6939: "Hurricane Electric",
    6453: "Tata", 6762: "Sparkle", 1273: "Vodafone", 3491: "PCCW", 4637: "Telstra Global", 1221: "Telstra",
    4826: "Vocus", 7545: "TPG", 9443: "Vocus", 38195: "Superloop", 4804: "Optus", 7474: "Optus", 7473: "Singtel",
    2516: "KDDI", 4134: "China Telecom", 4809: "China Telecom CN2", 9002: "RETN", 5511: "Orange", 3320: "Deutsche Telekom",
    701: "Verizon", 7018: "AT&T", 6461: "Zayo", 9498: "Airtel", 4755: "Tata", 3549: "Lumen", 2828: "Verizon",
    13335: "Cloudflare", 15169: "Google", 16509: "Amazon", 14618: "Amazon", 8075: "Microsoft", 32934: "Meta",
    20940: "Akamai", 16625: "Akamai", 54113: "Fastly", 2906: "Netflix", 40027: "Netflix", 32590: "Valve",
    36459: "GitHub", 714: "Apple", 6185: "Apple", 46489: "Twitch", 200325: "Bunny", 199524: "Gcore",
    45102: "Alibaba Cloud", 132203: "Tencent Cloud", 136907: "Huawei Cloud", 38365: "Baidu", 396986: "ByteDance",
    16276: "OVHcloud", 24940: "Hetzner", 20473: "Vultr", 14061: "DigitalOcean", 63949: "Linode", 31898: "Oracle Cloud",
    34343: "BIP (Eweka)", 34305: "Base IP", 12989: "Omicron (Highwinds)", 30094: "Giganews", 60068: "Datacamp", 13414: "X", 4635: "HKIX", 24115: "Equinix",
    7594: "IX Australia", 4739: "Internode", 1103: "SURF", 3209: "Vodafone DE", 8220: "Colt", 12956: "Telxius",
    6830: "Liberty Global", 5432: "Proximus", 2856: "BT", 5400: "BT", 64050: "BGPNET", 9304: "HGC",
}
CGNAT = ipaddress.ip_network("100.64.0.0/10")


def _dns_name(data, pos):
    """Decode a (possibly compressed) DNS name starting at pos."""
    labels, jumps = [], 0
    while data[pos]:
        if data[pos] & 0xC0 == 0xC0:
            pos = ((data[pos] & 0x3F) << 8) | data[pos + 1]
            jumps += 1
            if jumps > 20:
                break
            continue
        labels.append(data[pos + 1:pos + 1 + data[pos]].decode(errors="replace"))
        pos += data[pos] + 1
    return ".".join(labels)


def dns_ask(name, qtype, timeout=2):
    """Minimal DNS lookup over UDP (system resolver first, then 1.1.1.1): first TXT string or PTR name."""
    code = {"TXT": 16, "PTR": 12}[qtype]
    for server in (system_dns_servers() + ["1.1.1.1"])[:3]:
        tid = random.randint(0, 0xFFFF)
        q = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
        q += b"".join(bytes([len(p)]) + p.encode() for p in name.strip(".").split(".")) + b"\0" + struct.pack(">HH", code, 1)
        try:
            sock = socket.socket(socket.AF_INET6 if ":" in server else socket.AF_INET, socket.SOCK_DGRAM)
            sock.settimeout(timeout)
            try:
                sock.sendto(q, (server, 53))
                data = sock.recv(4096)
            finally:
                sock.close()
        except OSError:
            continue
        if len(data) < 12 or struct.unpack(">H", data[:2])[0] != tid:
            continue
        an = struct.unpack(">H", data[6:8])[0]
        pos = len(q)  # skip the echoed question
        try:
            for _ in range(an):
                if data[pos] & 0xC0 == 0xC0:
                    pos += 2
                else:
                    while data[pos]:
                        pos += data[pos] + 1
                    pos += 1
                rtype, _, _, rdlen = struct.unpack(">HHIH", data[pos:pos + 10])
                pos += 10
                if rtype == code and rdlen:
                    if code == 16:
                        return data[pos + 1:pos + 1 + data[pos]].decode(errors="replace")
                    return _dns_name(data, pos) or None
                pos += rdlen
        except (IndexError, struct.error):
            pass
        return None
    return None


def dns_txt(name, timeout=3):
    return dns_ask(name, "TXT", timeout)


_ptr_cache = {}


def reverse_dns(ip):
    """Hostname for an IP (PTR record), e.g. be3045.ccr41.lon13.atlas.cogentco.com, or None."""
    if ip not in _ptr_cache:
        try:
            a = ipaddress.ip_address(ip)
            _ptr_cache[ip] = dns_ask(a.reverse_pointer, "PTR")
        except (ValueError, OSError):
            _ptr_cache[ip] = None
    return _ptr_cache[ip]


# Suffixes that only exist inside home networks: never someone's registered domain.
LOCAL_SUFFIXES = {"local", "lan", "home", "internal", "localdomain", "arpa", "intranet", "corp", "private",
                  "localhost", "test", "invalid", "example", "router", "gateway", "domain", "station", "box"}
SECOND_LEVEL = {"com", "net", "org", "co", "gov", "edu", "ac", "id", "asn", "or", "ne", "go", "me", "ltd", "plc"}


def site_domain(host):
    """The registered domain in a hostname (unifi.home.example.com.au -> example.com.au), or None for
    names that only exist on a home network (router.lan, nas.local, x.home.arpa)."""
    labels = [x for x in str(host or "").lower().rstrip(".").split(".") if x]
    if len(labels) < 2 or labels[-1] in LOCAL_SUFFIXES or not labels[-1].isalpha():
        return None
    n = 3 if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in SECOND_LEVEL else 2
    return ".".join(labels[-n:])


def local_search_domains():
    """DNS search domains this machine got from DHCP or its settings (e.g. home.example.com)."""
    found = []
    for path in ("/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"):
        for line in (read_file(path) or "").splitlines():
            parts = line.split()
            if parts and parts[0] in ("search", "domain"):
                found += parts[1:]
    try:
        if platform.system() == "Darwin":
            out = subprocess.run(["scutil", "--dns"], capture_output=True, text=True, timeout=5).stdout
            found += re.findall(r"search domain\[\d+\] : (\S+)", out)
        elif IS_WINDOWS:
            out = subprocess.run(["ipconfig", "/all"], capture_output=True, text=True, timeout=10,
                                 errors="replace").stdout
            found += re.findall(r"(?:Primary Dns Suffix|DNS Suffix Search List|Connection-specific DNS Suffix)"
                                r"[ .]*: *(\S+)", out)
    except (OSError, subprocess.SubprocessError):
        pass
    return found


def local_global_ipv6():
    """This machine's global (internet) IPv6 addresses, on every interface."""
    found = []
    text = read_file("/proc/net/if_inet6")
    if text:
        found = [str(ipaddress.ip_address(int(line.split()[0], 16))) for line in text.splitlines() if line.strip()]
    else:
        try:
            out = subprocess.run(["ipconfig"] if IS_WINDOWS else ["ifconfig"], capture_output=True, text=True,
                                 timeout=10, errors="replace").stdout
            found = re.findall(r"[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}", out)
        except (OSError, subprocess.SubprocessError):
            pass
    try:  # the address used for the internet (no packets are sent for UDP connect)
        sk = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        sk.connect(("2606:4700:4700::1111", 53))
        found.append(sk.getsockname()[0])
        sk.close()
    except OSError:
        pass
    out = set()
    for ip in found:
        try:
            a = ipaddress.ip_address(ip.split("%")[0])
        except ValueError:
            continue
        if a.version == 6 and a.is_global:
            out.add(str(a))
    return sorted(out)


_asn_cache = {}


def ip_asn(ip):
    """(asn, name) for a public IP via Team Cymru's DNS service, or (None, None)."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None, None
    if a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or (a.version == 4 and a in CGNAT):
        return None, None
    if ip in _asn_cache:
        return _asn_cache[ip]
    if a.version == 4:
        q = ".".join(reversed(ip.split("."))) + ".origin.asn.cymru.com"
    else:
        q = ".".join(reversed(a.exploded.replace(":", ""))) + ".origin6.asn.cymru.com"
    txt = dns_txt(q)
    asn = None
    if txt:
        first = txt.split("|")[0].strip().split()
        asn = int(first[0]) if first and first[0].isdigit() else None
    result = (asn, as_name(asn)) if asn else (None, None)
    _asn_cache[ip] = result
    return result


_as_name_cache = {}


def as_name(asn):
    if asn in AS_NAMES:
        return AS_NAMES[asn]
    if asn not in _as_name_cache:
        txt = dns_txt(f"AS{asn}.asn.cymru.com") or ""
        raw = txt.split("|")[-1].strip() if "|" in txt else ""
        name = raw.split(" - ", 1)[1] if " - " in raw else raw
        name = re.sub(r",\s*[A-Z]{2}$", "", name)  # trailing country code
        name = re.sub(r"\s+-\s+(EMEA|APAC|AMER|AMERICAS|ASIA|EUROPE|EU|US|NA|LATAM|ME)\b.*$", "", name, flags=re.I)  # "GTT - EMEA"
        name = re.sub(r"\s+-\s+ME$", "", name)
        name = re.sub(r"[, ]+(Pty\.?|Ltd\.?|Limited|Inc\.?|LLC|L\.L\.C\.|Corporation|Corp\.?|Co\.?|GmbH|B\.V\.|AB|AG|S\.A\.|SA|plc|"
                      r"d\.o\.o\.|Communications|Telecommunications|Networks?|Holdings?|LTDA|S\.p\.A\.?|SAS|FZ-LLC|B\.V|"
                      r"Private Limited|Private|Pvt|Technologies)\b\.?", "", name, flags=re.I)
        if len(name) > 32:  # long registry names: keep the first few words
            name = " ".join(name.split()[:3]).rstrip(",")
        _as_name_cache[asn] = name.strip(" ,.-") or f"AS{asn}"
    return _as_name_cache[asn]


_IX = {"loaded": 0, "nets": []}


def load_ix_prefixes(cache_path):
    """Internet-exchange peering LAN prefixes from PeeringDB, refreshed daily, cached next to the database."""
    if time.time() - _IX["loaded"] < 86400 and _IX["nets"]:
        return
    rows = None
    try:
        def fetch(ep):  # PeeringDB rate-limits anonymous use: back off and retry on HTTP 429
            for attempt in range(3):
                try:
                    return http_json(f"https://www.peeringdb.com/api/{ep}", timeout=60)["data"]
                except urllib.error.HTTPError as e:
                    if e.code != 429 or attempt == 2:
                        raise
                    time.sleep(60 * (attempt + 1))
        lan_ix = {x["id"]: x["ix_id"] for x in fetch("ixlan")}
        ix = {x["id"]: [x["name"], x.get("city") or "", x.get("country") or ""] for x in fetch("ix")}
        rows = [[p["prefix"]] + ix.get(lan_ix.get(p["ixlan_id"]), ["Internet exchange", "", ""]) for p in fetch("ixpfx")]
        with open(cache_path, "w") as f:
            json.dump(rows, f)
    except Exception as e:
        log.warning("couldn't refresh internet-exchange prefixes from PeeringDB (%s); using the cached copy", e)
        try:
            with open(cache_path) as f:
                rows = json.load(f)
        except (OSError, ValueError):
            rows = rows or []
    nets = []
    for prefix, name, city, cc in rows or []:
        try:
            nets.append((ipaddress.ip_network(prefix, strict=False), name))
        except ValueError:
            pass
    _IX.update(loaded=time.time(), nets=nets)


def ix_for_ip(ip):
    """Name of the internet exchange whose peering LAN this address is on, if any."""
    try:
        a = ipaddress.ip_address(ip)
    except (ValueError, TypeError):
        return None
    return next((name for net, name in _IX["nets"] if a.version == net.version and a in net), None)


def is_ixp(name):
    return bool(re.search(r"(^|[\s-])IX($|[\s-])|internet exchange|\bexchange\b|-IX\b|IXP", name or "", re.I))


# Business relationships between networks, inferred by CAIDA from public BGP data and published monthly:
# "provider|customer|-1" (the customer pays for transit) or "peer|peer|0". Kept in its own small SQLite
# file next to the database (as-rel-YYYYMM.db, ~10 MB), so a refresh never locks the main database.
AS_REL_URL = "https://publicdata.caida.org/datasets/as-relationships/serial-1/{}01.as-rel.txt.bz2"
_REL = {"checked": 0, "dir": None, "path": None, "gen": 0, "local": threading.local(), "cache": {}}


def use_as_rel_dir(directory):
    """Use the newest as-rel-YYYYMM.db already downloaded into this directory, if any."""
    _REL["dir"] = directory
    found = sorted(glob.glob(os.path.join(directory, "as-rel-[0-9]*.db")))
    if found and found[-1] != _REL["path"]:
        _REL.update(path=found[-1], gen=_REL["gen"] + 1, cache={})


def as_rel_serial():
    """Month of the relationship data in use, e.g. '2026-09', or None."""
    m = re.search(r"as-rel-(\d{4})(\d{2})\.db$", _REL["path"] or "")
    return f"{m.group(1)}-{m.group(2)}" if m else None


def load_as_relationships():
    """Fetch the newest CAIDA relationship file once it's published (checked daily, fetched monthly)."""
    if not _REL["dir"] or time.time() - _REL["checked"] < 86400:
        return
    _REL["checked"] = time.time()
    have = (as_rel_serial() or "").replace("-", "")
    y, mo = time.gmtime()[:2]
    for back in range(4):  # CAIDA publishes a few weeks after the month starts: try this month and earlier
        serial = "%04d%02d" % (y + (mo - 1 - back) // 12, (mo - 1 - back) % 12 + 1)
        if serial <= have:
            break
        path = os.path.join(_REL["dir"], f"as-rel-{serial}.db")
        try:
            import bz2
            req = urllib.request.Request(AS_REL_URL.format(serial), headers={"User-Agent": f"netBae/{VERSION}"})
            tmp = path + ".tmp"
            if os.path.exists(tmp):
                os.remove(tmp)
            c = sqlite3.connect(tmp)
            try:
                c.execute("CREATE TABLE rel (a INTEGER, b INTEGER, rel INTEGER, PRIMARY KEY (a, b)) WITHOUT ROWID")
                with urllib.request.urlopen(req, timeout=120) as r, bz2.open(r, "rt") as f:
                    rows = (line.split("|")[:3] for line in f if line[:1].isdigit())
                    c.executemany("INSERT OR REPLACE INTO rel VALUES (?,?,?)",
                                  ((int(a), int(b), int(rel)) for a, b, rel in rows))
                c.commit()
            finally:
                c.close()
            os.replace(tmp, path)
            log.info("loaded CAIDA AS relationships for %s", serial)
            break
        except urllib.error.HTTPError as e:
            if e.code != 404:
                log.warning("couldn't fetch CAIDA AS relationships (%s)", e)
                return
        except Exception as e:
            log.warning("couldn't fetch CAIDA AS relationships (%s)", e)
            return
    use_as_rel_dir(_REL["dir"])
    for old in glob.glob(os.path.join(_REL["dir"], "as-rel-*.db*")):
        if old != _REL["path"]:
            try:
                os.remove(old)
            except OSError:
                pass  # still open somewhere (Windows): removed on a later refresh


def as_rel(a, b):
    """How network b relates to network a: 'peer', 'provider' (a buys transit from b),
    'customer' (b buys transit from a), or None if unknown."""
    if not a or not b or a == b or not _REL["path"]:
        return None
    if (a, b) in _REL["cache"]:
        return _REL["cache"][(a, b)]
    loc = _REL["local"]
    if getattr(loc, "gen", None) != _REL["gen"]:
        if getattr(loc, "c", None):
            loc.c.close()
        loc.c = sqlite3.connect(_REL["path"]) if os.path.exists(_REL["path"]) else None
        loc.gen = _REL["gen"]
    rel = None
    if loc.c:
        row = loc.c.execute("SELECT a, rel FROM rel WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)", (a, b, b, a)).fetchone()
        if row:
            rel = "peer" if row[1] == 0 else ("customer" if row[0] == a else "provider")
    _REL["cache"][(a, b)] = rel
    return rel


def with_rels(path):
    """Mark each network on a route with its relationship to the network before it (exchanges skipped)."""
    prev = None
    for x in path:
        if x.get("ixp") or not x.get("asn"):
            continue
        if prev:
            x["rel"] = as_rel(prev["asn"], x["asn"])
        prev = x
    return path


HOP_RE = re.compile(r"^\s*(\d+)[:?]*\s+(.*)$")


def traceroute(host, max_hops=25, bind=None):
    """[(hop, ip or None, rtt_ms or None)] using the system traceroute (or tracepath / tracert)."""
    if IS_WINDOWS:
        cmd = ["tracert", "-d", "-h", str(max_hops), "-w", "1000"] + (["-S", bind] if bind and is_ip(bind) and ":" in bind else [])
    elif IS_MAC and ":" in host:  # macOS traceroute is IPv4-only
        cmd = ["/usr/sbin/traceroute6", "-n", "-q", "1", "-w", "1", "-m", str(max_hops)]
        if bind:
            cmd += ["-s", bind] if is_ip(bind) else []
    elif shutil.which("traceroute") or os.path.exists("/usr/sbin/traceroute"):
        exe = shutil.which("traceroute") or "/usr/sbin/traceroute"
        cmd = [exe, "-n", "-q", "1", "-w", "1", "-m", str(max_hops)]
        if bind:
            cmd += ["-s", bind] if is_ip(bind) else ["-i", bind]
    elif shutil.which("tracepath"):
        cmd = ["tracepath", "-n", "-m", str(max_hops)]
    else:
        raise OSError("no traceroute command found (install the 'traceroute' package)")
    out = subprocess.run(cmd + [host], capture_output=True, text=True, errors="replace",
                         timeout=max_hops * 6 + 10, **SUBPROCESS_FLAGS).stdout
    hops = {}
    for line in out.splitlines():
        m = HOP_RE.match(line)
        if not m:
            continue
        n, rest = int(m.group(1)), m.group(2)
        ip = next((t.strip("()[]") for t in rest.split() if is_ip(t.strip("()[]"))), None)
        rtt = re.search(r"<?([\d.]+)\s*ms", rest)
        if n not in hops or (ip and not hops[n][0]):
            hops[n] = (ip, float(rtt.group(1)) if rtt and ip else None)
    hops = [(n, ip, rtt) for n, (ip, rtt) in sorted(hops.items())]
    while hops and not hops[-1][1]:  # drop the run of timeouts at the end
        hops.pop()
    return hops


# --------------------------------------------------------------------------- hop locations
# Router hostnames usually name their city: an airport code (be3021.ccr41.syd01.atlas.cogentco.com,
# ae2.cr0-lax1.ip4.gtt.net), a 6-letter city code (ae-6.r24.tokyjp05.jp.bb.gin.ntt.net) or the city
# itself (ae-1.LosAngeles1.Level3.net). Hops without one fall back to IP geolocation (approximate).
_C = {
    "Sydney, AU": "syd sydney sydnau", "Melbourne, AU": "mel melbourne", "Brisbane, AU": "bne brisbane",
    "Perth, AU": "per perth", "Adelaide, AU": "adl adelaide", "Canberra, AU": "cbr canberra", "Darwin, AU": "drw darwin",
    "Hobart, AU": "hba hobart", "Auckland, NZ": "akl auckland", "Wellington, NZ": "wlg wellington",
    "Christchurch, NZ": "chc christchurch", "Singapore, SG": "sin sgp singapore sngpsg", "Hong Kong, HK": "hkg hongkong",
    "Tokyo, JP": "tyo nrt hnd tokyo tokyjp", "Osaka, JP": "osa kix osaka osakjp", "Seoul, KR": "sel icn seoul",
    "Taipei, TW": "tpe taipei", "Kuala Lumpur, MY": "kul kualalumpur", "Bangkok, TH": "bkk bangkok",
    "Jakarta, ID": "cgk jkt jakarta", "Manila, PH": "mnl manila", "Mumbai, IN": "bom mumbai", "Delhi, IN": "del delhi",
    "Chennai, IN": "maa chennai", "Bangalore, IN": "blr bangalore", "Dubai, AE": "dxb dubai", "Fujairah, AE": "fjr fujairah",
    "Muscat, OM": "mct muscat", "Guam, GU": "gum guam", "Honolulu, US": "hnl honolulu",
    "Los Angeles, US": "lax losangeles lsanca", "San Jose, US": "sjc sanjose snjsca", "Palo Alto, US": "pao paloalto plalca",
    "San Francisco, US": "sfo sanfrancisco", "Seattle, US": "sea seattle sttlwa", "Portland, US": "pdx portland",
    "Salt Lake City, US": "slc saltlakecity", "Phoenix, US": "phx phoenix", "Denver, US": "den denver dnvrco",
    "Dallas, US": "dfw dal dallas dllstx", "Houston, US": "iah hou houston", "Kansas City, US": "mci kansascity",
    "Chicago, US": "ord chi chicago chcgil", "Minneapolis, US": "msp minneapolis", "St. Louis, US": "stl stlouis",
    "Atlanta, US": "atl atlanta atlnga", "Miami, US": "mia miami miamfl", "Ashburn, US": "iad ash ashburn asbnva",
    "Washington, US": "was washington", "New York, US": "nyc jfk lga newyork nycmny", "Newark, US": "ewr newark nwrknj",
    "Boston, US": "bos boston", "Philadelphia, US": "phl philadelphia", "Toronto, CA": "yyz tor toronto",
    "Montreal, CA": "yul mtl montreal", "Vancouver, CA": "yvr vancouver", "Mexico City, MX": "mex mexico",
    "Querétaro, MX": "qro queretaro", "São Paulo, BR": "gru sao saopaulo", "Rio de Janeiro, BR": "gig rio",
    "Santiago, CL": "scl santiago", "Buenos Aires, AR": "eze buenosaires", "Bogotá, CO": "bog bogota", "Lima, PE": "lim lima",
    "London, GB": "lon lhr london londen", "Manchester, GB": "manchester", "Dublin, IE": "dub dublin",
    "Amsterdam, NL": "ams amsterdam amstnl", "Frankfurt, DE": "fra frankfurt frnkge", "Berlin, DE": "ber txl berlin",
    "Düsseldorf, DE": "dus dusseldorf", "Munich, DE": "muc munich", "Hamburg, DE": "ham hamburg", "Paris, FR": "par cdg paris parsfr",
    "Marseille, FR": "mrs marseille", "Brussels, BE": "bru brussels", "Zurich, CH": "zrh zurich", "Geneva, CH": "gva geneva",
    "Vienna, AT": "vie vienna", "Milan, IT": "mil mxp milan", "Rome, IT": "rom rome", "Madrid, ES": "mad madrid",
    "Barcelona, ES": "bcn barcelona", "Lisbon, PT": "lis lisbon", "Stockholm, SE": "sto arn stockholm",
    "Copenhagen, DK": "cph copenhagen", "Oslo, NO": "osl oslo", "Helsinki, FI": "hel helsinki", "Warsaw, PL": "waw warsaw",
    "Prague, CZ": "prg prague", "Budapest, HU": "bud budapest", "Bucharest, RO": "buh otp bucharest", "Sofia, BG": "sof sofia",
    "Athens, GR": "ath athens", "Istanbul, TR": "ist istanbul", "Tel Aviv, IL": "tlv telaviv",
    "Johannesburg, ZA": "jnb johannesburg", "Cape Town, ZA": "cpt capetown", "Nairobi, KE": "nbo nairobi",
    "Lagos, NG": "lagos", "Cairo, EG": "cai cairo",
}
CITY_CODES = {code: city for city, codes in _C.items() for code in codes.split()}
del _C


def city_from_hostname(host):
    """'Sydney, AU' from a router name like be3021.ccr41.syd01.atlas.cogentco.com, or None."""
    labels = (host or "").lower().split(".")
    for label in labels[:-2]:  # the last two labels are the operator's domain (e.g. cogentco.com)
        words = [t.strip("0123456789") for t in re.split(r"[-_]", label)]
        pairs = [a + b for a, b in zip(words, words[1:])]  # los-angeles, new-york, san-jose
        for word in pairs + words:
            if len(word) >= 3 and word in CITY_CODES:
                return CITY_CODES[word]
    return None


def km_between(a, b):
    """Great-circle distance in km between two (lat, lon) points."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(min(1, math.sqrt(h)))


class HopGeo:
    """IP geolocation for hops without a city in their name (ipinfo.io), cached in the database for
    30 days and capped per day so it stays well inside ipinfo's free allowance."""
    DAILY = 300

    def __init__(self, db):
        self.db, self.mem, self.day, self.used, self.lock = db, {}, None, 0, threading.Lock()

    def lookup(self, ip):
        """{city, lat, lon} or None."""
        if ip in self.mem:
            return self.mem[ip]
        row = self.db.query("SELECT city, lat, lon FROM hop_geo WHERE ip = ? AND ts > ?", (ip, time.time() - 30 * 86400))
        if row:
            self.mem[ip] = {"city": row[0][0], "lat": row[0][1], "lon": row[0][2]} if row[0][0] else None
            return self.mem[ip]
        with self.lock:
            today = time.strftime("%Y-%m-%d")
            if self.day != today:
                self.day, self.used = today, 0
            if self.used >= self.DAILY:
                return None
            self.used += 1
        try:
            d = http_json(f"https://ipinfo.io/{ip}/json", timeout=8)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                self.used = self.DAILY  # over ipinfo's limit: try again tomorrow
            return None
        except Exception:
            return None
        city = ", ".join(x for x in (d.get("city"), d.get("country")) if x) or None
        lat, _, lon = (d.get("loc") or "").partition(",")
        try:
            g = {"city": city, "lat": float(lat), "lon": float(lon)} if city else None
        except ValueError:
            g = None
        self.db.insert_many("INSERT OR REPLACE INTO hop_geo VALUES (?,?,?,?,?)",
                            [(ip, time.time(), g and g["city"], g and g["lat"], g and g["lon"])])
        self.mem[ip] = g
        return g


def locate_hops(detailed, geo=None, home_ip=None):
    """Give each public hop a city: from its hostname, else from IP geolocation if that's physically
    possible (light in fibre covers ~100 km per ms of round trip, so a 9 ms hop can't be 2,000 km away)."""
    home = geo.lookup(home_ip) if geo and home_ip else None
    for h in detailed:
        if h.get("city") or not h.get("ip") or not PublicMask.is_public_ip(h["ip"]):
            continue
        city = city_from_hostname(h.get("host"))
        if city:
            h["city"], h["city_src"] = city, "name"
            continue
        g = geo.lookup(h["ip"]) if geo else None
        if not g:
            continue
        if home and h.get("rtt") is not None and h["rtt"] * 100 < km_between((home["lat"], home["lon"]), (g["lat"], g["lon"])) * 0.8:
            continue  # too close in time to be that far away (anycast, or a stale geolocation entry)
        h["city"], h["city_src"] = g["city"], "geo"
    return detailed


def route_cities(detailed):
    """Cities a route passes through, in order, without repeats."""
    out = []
    for h in detailed:
        if h.get("city") and (not out or out[-1] != h["city"]):
            out.append(h["city"])
    return out


def classify_route(hops, dest_ip, isp_asn=None):
    """Annotate hops with ASNs and work out how traffic reaches the destination network."""
    detailed, path = [], []
    with ThreadPoolExecutor(max_workers=8) as pool:  # hostnames (PTR) for every hop, like mtr shows
        names = list(pool.map(lambda h: reverse_dns(h[1]) if h[1] else None, hops))
    for (n, ip, rtt), host in zip(hops, names):
        asn, name = ip_asn(ip) if ip else (None, None)
        m = re.search(r"(?:^|[.-])as(\d{3,6})(?:[.-]|$)", host or "", re.I)
        if not asn and m and ip and not ipaddress.ip_address(ip).is_private:
            asn = int(m.group(1))  # unannounced backbone address, but the hostname names its network
            name = as_name(asn)
        ix = ix_for_ip(ip) if ip else None
        detailed.append({"hop": n, "ip": ip, "host": host, "rtt": rtt, "asn": asn, "name": name, "ix": ix})
        if ix:  # an exchange's peering LAN: the hand-over between two networks happens here
            if not path or path[-1]["name"] != ix:
                path.append({"asn": None, "name": ix, "ixp": True})
        elif asn and (not path or (path[-1]["asn"] != asn and path[-1]["name"] != name)):
            path.append({"asn": asn, "name": name, "ixp": is_ixp(name)})
    dest_asn, dest_name = ip_asn(dest_ip) if dest_ip else (None, None)
    if dest_asn and (not path or path[-1]["asn"] != dest_asn):
        path.append({"asn": dest_asn, "name": dest_name, "ixp": False, "unseen": True})
    isp_asn = isp_asn or (path[0]["asn"] if path else None)
    if not path or not dest_asn:
        kind = "unknown"
    elif dest_asn == isp_asn:
        kind = "on-net"
    else:
        middle = [x for x in path if x["asn"] not in (isp_asn, dest_asn) or x["ixp"]]
        if middle and middle[0]["ixp"]:
            kind = "ix"               # your ISP hands over at an internet exchange (even if a carrier follows)
        elif middle:
            kind = "transit"          # another carrier sits between your ISP and the destination
        else:
            kind = "direct"           # your ISP connects straight to the destination's network
    return kind, path, detailed


def dns_query(server, domain, timeout):
    """Send a single A-record query over UDP and return the response time in ms."""
    try:
        family, _, _, _, addr = socket.getaddrinfo(server, 53, type=socket.SOCK_DGRAM)[0]
    except OSError:
        return None
    tid = random.randint(0, 0xFFFF)
    header = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)  # recursion desired
    qname = b"".join(bytes([len(p)]) + p.encode() for p in domain.strip(".").split(".")) + b"\0"
    packet = header + qname + struct.pack(">HH", 1, 1)
    s = socket.socket(family, socket.SOCK_DGRAM)
    try:
        deadline = time.perf_counter() + timeout
        t0 = time.perf_counter()
        s.sendto(packet, addr)
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return None
            s.settimeout(remaining)
            data, _ = s.recvfrom(4096)
            if len(data) >= 12 and struct.unpack(">H", data[:2])[0] == tid:
                break
        elapsed = (time.perf_counter() - t0) * 1000
        rcode = data[3] & 0x0F
        return elapsed if rcode in (0, 3) else None  # NOERROR / NXDOMAIN count as answered
    except OSError:
        return None
    finally:
        s.close()


# --------------------------------------------------------------------------- system info

def read_file(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def run_cmd(args):
    """stdout of a short-lived command, or None."""
    try:
        p = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=5, **SUBPROCESS_FLAGS)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout.strip() if p.returncode == 0 else None


def sysctl(name):
    return run_cmd(["/usr/sbin/sysctl", "-n", name])


class MacCPU:
    """Cumulative CPU ticks from the Mach host_statistics() call (macOS has no /proc/stat)."""
    HOST_CPU_LOAD_INFO = 3
    CPU_STATE_MAX = 4  # user, system, idle, nice

    def __init__(self):
        self.lib = ctypes.CDLL(ctypes.util.find_library("System") or "/usr/lib/libSystem.B.dylib")
        self.lib.mach_host_self.restype = ctypes.c_uint32
        self.lib.host_statistics.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_void_p,
                                             ctypes.POINTER(ctypes.c_uint32)]
        self.host = self.lib.mach_host_self()

    def ticks(self):
        info = (ctypes.c_uint32 * self.CPU_STATE_MAX)()
        count = ctypes.c_uint32(self.CPU_STATE_MAX)
        if self.lib.host_statistics(self.host, self.HOST_CPU_LOAD_INFO, info, ctypes.byref(count)) != 0:
            return None
        user, system, idle, nice = info
        return idle, user + system + idle + nice


class FILETIME(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]

    @property
    def value(self):
        return (self.high << 32) | self.low


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                ("ullAvailExtendedVirtual", ctypes.c_uint64)]


class WinStats:
    """CPU, memory and uptime from kernel32 (Windows has no /proc)."""

    def __init__(self):
        self.k32 = ctypes.WinDLL("kernel32")
        self.k32.GetTickCount64.restype = ctypes.c_uint64

    def ticks(self):
        idle, kernel, user = FILETIME(), FILETIME(), FILETIME()
        if not self.k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return idle.value, kernel.value + user.value  # kernel time includes idle time

    def meminfo(self):
        m = MEMORYSTATUSEX()
        m.dwLength = ctypes.sizeof(m)
        if not self.k32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return None
        total, avail = m.ullTotalPhys, m.ullAvailPhys
        # The commit limit is RAM + page file, so what is committed beyond RAM is the page file in use.
        swap_total = max(m.ullTotalPageFile - total, 0)
        swap_used = min(max((m.ullTotalPageFile - m.ullAvailPageFile) - (total - avail), 0), swap_total)
        return {
            "total": total, "available": avail, "used": total - avail,
            "percent": round(100.0 * (total - avail) / total, 1) if total else None,
            "swap_total": swap_total, "swap_used": swap_used,
        }

    def uptime(self):
        return self.k32.GetTickCount64() / 1000

    @staticmethod
    def reg(path, name):
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as k:
                return str(winreg.QueryValueEx(k, name)[0]).strip() or None
        except OSError:
            return None

    @classmethod
    def static_info(cls):
        bios = r"HARDWARE\DESCRIPTION\System\BIOS"
        model = " ".join(filter(None, (cls.reg(bios, "SystemManufacturer"), cls.reg(bios, "SystemProductName"))))
        nt = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
        name = cls.reg(nt, "ProductName")
        build = cls.reg(nt, "CurrentBuildNumber") or ""
        if name and build.isdigit() and int(build) >= 22000:  # Windows 11 still says "Windows 10" here
            name = name.replace("Windows 10", "Windows 11")
        if name and cls.reg(nt, "DisplayVersion"):
            name = f"{name} {cls.reg(nt, 'DisplayVersion')}"
        cpu = cls.reg(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString")
        return model or None, name or f"Windows {platform.release()} ({platform.version()})", cpu


class SystemStats:
    def __init__(self, disk_path):
        if IS_WINDOWS and disk_path in ("/", "\\"):  # the shipped config's "/" means the system drive
            disk_path = os.environ.get("SystemDrive", "C:") + "\\"
        self.disk_path = disk_path
        self.prev_cpu = None
        self.latest = {}
        self.mac_cpu = None
        self.win = None
        if IS_WINDOWS:
            try:
                self.win = WinStats()
            except (OSError, AttributeError):
                log.warning("could not load kernel32 for system stats")
        if IS_MAC:
            try:
                self.mac_cpu = MacCPU()
            except (OSError, AttributeError):
                log.warning("could not read CPU usage via host_statistics()")

    def cpu_ticks(self):
        """(idle, total) cumulative CPU ticks."""
        if self.mac_cpu:
            return self.mac_cpu.ticks()
        if self.win:
            return self.win.ticks()
        line = read_file("/proc/stat")
        if not line:
            return None
        vals = [int(v) for v in line.splitlines()[0].split()[1:9]]
        return vals[3] + vals[4], sum(vals)

    def cpu_percent(self):
        cur = self.cpu_ticks()
        if not cur:
            return None
        idle, total = cur
        prev, self.prev_cpu = self.prev_cpu, (idle, total)
        if not prev or total == prev[1]:
            return None
        return round(100.0 * (1 - (idle - prev[0]) / (total - prev[1])), 1)

    def meminfo(self):
        if self.win:
            return self.win.meminfo()
        raw = read_file("/proc/meminfo")
        if not raw:
            return SystemStats.mac_meminfo() if IS_MAC else None
        info = {}
        for line in raw.splitlines():
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) * 1024
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", info.get("MemFree", 0))
        return {
            "total": total, "available": avail, "used": total - avail,
            "percent": round(100.0 * (total - avail) / total, 1) if total else None,
            "swap_total": info.get("SwapTotal", 0),
            "swap_used": info.get("SwapTotal", 0) - info.get("SwapFree", 0),
        }

    @staticmethod
    def mac_meminfo():
        """Memory like Activity Monitor: used = app memory + wired + compressed."""
        total, raw = sysctl("hw.memsize"), run_cmd(["/usr/bin/vm_stat"])
        if not total or not raw:
            return None
        total = int(total)
        m = re.search(r"page size of (\d+) bytes", raw)
        page = int(m.group(1)) if m else 4096
        pages = {k.strip().strip('"'): int(v.strip().rstrip("."))
                 for k, v in (line.split(":", 1) for line in raw.splitlines()[1:] if ":" in line)
                 if v.strip().rstrip(".").isdigit()}
        app = pages.get("Anonymous pages", 0) - pages.get("Pages purgeable", 0)
        used = (max(app, 0) + pages.get("Pages wired down", 0) + pages.get("Pages occupied by compressor", 0)) * page
        used = min(used, total)
        swap_total = swap_used = 0
        swap = sysctl("vm.swapusage") or ""  # total = 2048.00M  used = 1024.50M  free = ...
        units = {"K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}
        for key, val, unit in re.findall(r"(total|used) = ([\d.]+)([KMG])", swap):
            n = int(float(val) * units[unit])
            if key == "total":
                swap_total = n
            else:
                swap_used = n
        return {
            "total": total, "available": total - used, "used": used,
            "percent": round(100.0 * used / total, 1) if total else None,
            "swap_total": swap_total, "swap_used": swap_used,
        }

    def disk(self):
        if not hasattr(os, "statvfs"):  # Windows
            try:
                total, used, free = shutil.disk_usage(self.disk_path)
            except OSError:
                return None
            return {"path": self.disk_path, "total": total, "used": used, "free": free,
                    "percent": round(100.0 * used / total, 1) if total else None}
        try:
            st = os.statvfs(self.disk_path)
        except OSError:
            return None
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        used = total - st.f_bfree * st.f_frsize
        return {"path": self.disk_path, "total": total, "used": used, "free": free,
                "percent": round(100.0 * used / (used + free), 1) if (used + free) else None}

    @staticmethod
    def temperature():
        # macOS only exposes sensors to root (powermetrics), so it has no temperature reading.
        best = None
        base = "/sys/class/thermal"
        try:
            zones = sorted(z for z in os.listdir(base) if z.startswith("thermal_zone"))
        except OSError:
            zones = []
        for z in zones:
            v = read_file(f"{base}/{z}/temp")
            if v and v.lstrip("-").isdigit():
                c = int(v) / 1000
                if 0 < c < 150:
                    best = c if best is None else max(best, c)
        if best is None:  # fall back to hwmon (common on x86)
            try:
                for h in os.listdir("/sys/class/hwmon"):
                    v = read_file(f"/sys/class/hwmon/{h}/temp1_input")
                    if v and v.isdigit():
                        c = int(v) / 1000
                        if 0 < c < 150:
                            best = c if best is None else max(best, c)
            except OSError:
                pass
        return round(best, 1) if best is not None else None

    @staticmethod
    def loadavg():
        raw = read_file("/proc/loadavg")
        if raw:
            return [float(x) for x in raw.split()[:3]]
        try:
            return list(os.getloadavg())
        except (OSError, AttributeError):  # Windows has no load average
            return None

    def uptime(self):
        if self.win:
            return self.win.uptime()
        raw = read_file("/proc/uptime")
        if raw:
            return float(raw.split()[0])
        m = re.search(r"sec = (\d+)", sysctl("kern.boottime") or "") if IS_MAC else None
        return time.time() - int(m.group(1)) if m else None

    @staticmethod
    def primary_ip():
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("1.1.1.1", 53))  # no packets are sent for UDP connect
            ip = s.getsockname()[0]
            s.close()
            return ip
        except OSError:
            return None

    def static_info(self):
        model = (read_file("/proc/device-tree/model") or "").rstrip("\x00")
        if not model:
            vendor = read_file("/sys/class/dmi/id/sys_vendor") or ""
            product = read_file("/sys/class/dmi/id/product_name") or ""
            model = f"{vendor} {product}".strip()
        os_name = None
        raw = read_file("/etc/os-release")
        if raw:
            for line in raw.splitlines():
                if line.startswith("PRETTY_NAME="):
                    os_name = line.split("=", 1)[1].strip('"')
        cpu_model = None
        raw = read_file("/proc/cpuinfo") or ""
        for line in raw.splitlines():
            if line.lower().startswith(("model name", "hardware")):
                cpu_model = line.split(":", 1)[1].strip()
                break
        if IS_MAC:
            model = model or sysctl("hw.model") or ""
            cpu_model = cpu_model or sysctl("machdep.cpu.brand_string")
            name, ver = run_cmd(["/usr/bin/sw_vers", "-productName"]), run_cmd(["/usr/bin/sw_vers", "-productVersion"])
            if name and ver:
                os_name = f"{name} {ver}"
        if IS_WINDOWS:
            model, os_name, cpu_model = WinStats.static_info()
        hostname = (run_cmd(["/usr/sbin/scutil", "--get", "LocalHostName"]) if IS_MAC else None) \
            or socket.gethostname()
        return {
            "hostname": hostname,
            "model": model or None,
            "os": os_name or f"{platform.system()} {platform.release()}",
            "kernel": platform.release(),
            "arch": platform.machine(),
            "cpu_model": cpu_model,
            "cpu_count": os.cpu_count(),
        }

    def sample(self):
        mem = self.meminfo()
        disk = self.disk()
        load = self.loadavg()
        self.latest = {
            "ts": time.time(),
            "cpu": self.cpu_percent(),
            "mem": mem,
            "disk": disk,
            "temp": self.temperature(),
            "load": load,
        }
        return self.latest


# --------------------------------------------------------------------------- monitor

class Monitor:
    def __init__(self, cfg):
        self.cfg = cfg
        self.db = DB(cfg["storage"]["database"])
        use_as_rel_dir(os.path.dirname(os.path.abspath(self.db.path)))
        self.sys = SystemStats(cfg["system"]["disk_path"])
        self.static_info = self.sys.static_info()
        self.pool = ThreadPoolExecutor(max_workers=32, thread_name_prefix="probe")
        self.st_lock = threading.Lock()
        self.st_status = {"running": False}
        self.region_cache = {}
        self.region_lookups = set()
        self.game_cache = {}
        self.trace_lock = threading.Lock()
        self.hop_geo = HopGeo(self.db)
        self.docker_bridge = docker_bridge()
        if self.docker_bridge:
            log.warning("running on Docker's bridge network: the router, DHCP DNS and routes will show Docker's "
                        "network, not yours. Use network_mode: host for accurate results.")
        self.ipv6 = (0, None)  # (checked_at, available)
        self.addr_cache = {}   # (host, 4|6) -> (checked_at, address or None)
        self.started = time.time()
        self.config_path = None
        # public dashboard sharing, shown on the private dashboard
        self.public_visitors, self.public_direct_ts = {}, None
        self.share, self.share_ts, self.share_busy = {"tunnels": []}, 0, False
        self.share_lock = threading.Lock()

    def start(self):
        c = self.cfg
        self.sys.cpu_percent()  # prime the CPU delta
        run_aligned("ping", c["ping"]["interval_seconds"], c["ping"]["offset_seconds"], self.collect_ping)
        if c["ping"]["regions"]:
            run_aligned("ping-regions", c["ping"]["region_interval_seconds"], c["ping"]["offset_seconds"],
                        self.collect_region_pings)
        if c["dns"]["enabled"] and c["dns"]["servers"] and c["dns"]["domains"]:
            run_aligned("dns", c["dns"]["interval_seconds"], c["dns"]["offset_seconds"], self.collect_dns)
        run_aligned("system", c["system"]["interval_seconds"], c["system"]["offset_seconds"], self.collect_system)
        if c["isp"]["enabled"]:
            run_aligned("isp", c["isp"]["interval_minutes"] * 60, c["isp"]["offset_minutes"] * 60, self.collect_isp)
            self.pool.submit(self.collect_isp)  # know the ISP straight away
        if c["traceroute"]["enabled"]:
            run_aligned("traceroute", c["traceroute"]["interval_hours"] * 3600,
                        c["traceroute"]["offset_minutes"] * 60, self.collect_traceroutes)
            threading.Thread(target=self.first_traces, name="traceroute-first", daemon=True).start()
        if c["speedtest"]["enabled"]:
            run_aligned("speedtest", c["speedtest"]["interval_minutes"] * 60,
                        c["speedtest"]["offset_minutes"] * 60, self.run_speedtest)
            if c["speedtest"]["regions"]:
                run_aligned("speedtest-regions", c["speedtest"]["regions_interval_minutes"] * 60,
                            c["speedtest"]["regions_offset_minutes"] * 60,
                            lambda: self.run_speedtest(scope="regions"))
            for conn in c["connections"]:
                if conn["speedtest"] and conn["speedtest_interval_minutes"] > 0:
                    run_aligned(f"speedtest-{conn['name']}", conn["speedtest_interval_minutes"] * 60,
                                conn["speedtest_offset_minutes"] * 60,
                                lambda n=conn["name"]: self.run_speedtest(scope=f"conn:{n}"))
        run_aligned("rollup", 60, 10, self.rollup_all)
        run_aligned("cleanup", 3600, 1800, self.cleanup)
        self.pool.submit(self.collect_system)

    # -- collectors
    def address(self, host, family):
        """host's IPv4 or IPv6 address (looked up every 5 minutes, every minute while it has none), or None."""
        if is_ip(host):
            if ":" not in host and family == 6:
                return V6_TWIN.get(host)
            return host if (":" in host) == (family == 6) else None
        hit = self.addr_cache.get((host, family))
        if hit and time.time() - hit[0] < (300 if hit[1] else 60):
            return hit[1]
        try:
            found = [i[4][0] for i in socket.getaddrinfo(host, None, socket.AF_INET6 if family == 6 else socket.AF_INET,
                                                          socket.SOCK_STREAM)]
        except OSError:
            found = []
        # macOS returns IPv4-mapped addresses (::ffff:1.2.3.4) for IPv4-only sites, and NAT64 networks
        # synthesize 64:ff9b:: ones: both still reach the site over IPv4, so they don't count as IPv6
        addr = next((a for a in found if not (":" in a and (ipaddress.ip_address(a.split("%")[0]).ipv4_mapped
                                                            or a.lower().startswith("64:ff9b:")))), None)
        self.addr_cache[(host, family)] = (time.time(), addr)
        return addr

    def v6_live(self, t):
        """An IPv6 twin worth showing: this machine has IPv6 and the site has an IPv6 address."""
        if not self.ipv6_available():
            return False
        if is_ip(t["host"]):
            return t["host"] in V6_TWIN
        return bool((self.addr_cache.get((t["host"], 6)) or (0, None))[1])

    def ping_one(self, t):
        timeout = self.cfg["ping"]["timeout_seconds"]
        bind = t.get("bind")
        if t.get("family"):  # measured over IPv4 and IPv6 separately: ping that family's address
            if t["family"] == 6 and not self.ipv6_available():
                return SKIP  # no failures recorded on an IPv4-only network
            addr = self.address(t["host"], t["family"])
            if not addr:
                return SKIP if t["family"] == 6 else None  # a site without IPv6 just has no IPv6 line
            if t["method"] == "tcp":
                return tcp_ping(addr, t["port"], timeout)
            return icmp_ping(addr, timeout)
        if t["method"] == "game":
            srv = self.game_server(t)
            if not srv:
                return SKIP
            if srv["method"] == "tcp":
                return tcp_ping(srv["host"], srv["port"], timeout, bind)
            return icmp_ping(srv["host"], timeout, bind)
        if t["method"] == "tcp":
            return tcp_ping(t["host"], t["port"], timeout, bind)
        return icmp_ping(t["host"], timeout, bind)

    def game_server(self, t):
        """Resolved game/voice server for a target (cached daily, looked up in the background)."""
        key = (t["id"], t.get("bind"))
        cached = self.game_cache.get(key)
        if cached and cached[0] > 0 and time.time() - cached[0] < (86400 if cached[1] else 600):
            return cached[1]
        if not cached or cached[0] > 0:
            self.game_cache[key] = (-1, cached[1] if cached else None)  # lookup in progress
            self.pool.submit(self._lookup_game, t, key)
        return self.game_cache[key][1]

    def _lookup_game(self, t, key):
        try:
            srv = resolve_game_server(t["provider"], t["pref"], t.get("bind"))
        except Exception as e:
            log.warning("could not find a %s server: %s", t["provider"], e)
            srv = None
        self.game_cache[key] = (time.time(), srv)
        if srv:
            port = ":%s" % srv["port"] if srv["port"] else ""
            t["display"] = "%s · %s%s" % (srv["label"], srv["host"], port)
            # shown on the tile: the city/region measured, and whether it was picked as the nearest
            t["where"] = srv["label"] + (" (nearest)" if t["pref"] == "auto" else "")

    def region_servers(self, region, wait=True):
        """Cached fastest-first server list for a region; refreshed daily. None if unknown yet."""
        name = region["name"]
        cached = self.region_cache.get(name)
        if cached and time.time() - cached[0] < (86400 if cached[1] else 600):
            return cached[1]
        if not wait:  # look up in the background so a collector tick never blocks on it
            if name not in self.region_lookups:
                self.region_lookups.add(name)
                self.pool.submit(self._lookup_region, region)
            return cached[1] if cached else None
        return self._lookup_region(region)

    def _lookup_region(self, region):
        try:
            servers = find_region_servers(region)
        except Exception as e:
            log.warning("speedtest server lookup for %s failed: %s", region["name"], e)
            servers = []
        finally:
            self.region_lookups.discard(region["name"])
        self.region_cache[region["name"]] = (time.time(), servers)
        return servers

    def trace_targets(self):
        """(id, host, bind) for every ping target plus the latest main speedtest server."""
        out = []
        for t in self.cfg["ping"]["targets"]:
            host = None
            if t["method"] == "game":
                srv = self.game_server(t)
                host = srv and srv["host"]
            elif t["method"] == "region":
                srv = [c for c in (self.region_servers(t["region"], wait=False) or []) if c["host"]]
                host = srv[0]["host"] if srv else None
            elif t.get("family") == 6:
                if not self.cfg["traceroute"]["ipv6"] or not self.ipv6_available():
                    continue
                host = self.address(t["host"], 6)
            else:
                host = t["host"]
            if host and host != "gateway" and not t["id"].endswith("gateway"):  # the router is one hop away
                out.append((t["id"], host, t.get("bind")))
        row = self.db.query("SELECT server_host FROM speedtest WHERE COALESCE(kind, 'main') = 'main'"
                            " AND server_host IS NOT NULL ORDER BY ts DESC LIMIT 1")
        if row:
            out.append(("speedtest:Auto", row[0][0], None))
        return out

    def lookups_done(self):
        """True once every game and region target has had its server looked up."""
        for t in self.cfg["ping"]["targets"]:
            if t["method"] == "game" and (self.game_cache.get((t["id"], t.get("bind"))) or (0,))[0] <= 0:
                return False
            if t["method"] == "region" and t["region"]["name"] not in self.region_cache:
                return False
        return True

    def first_traces(self):
        """Right after start, trace every target with no recent route (new installs, newly added targets,
        or a machine that was off), as soon as game/region servers are known (at most ~90 s)."""
        deadline = time.time() + 90
        time.sleep(5)  # let the first ping round kick off the server lookups
        while time.time() < deadline and not self.lookups_done():
            time.sleep(5)
        cutoff = time.time() - self.cfg["traceroute"]["interval_hours"] * 3600
        fresh = {r[0] for r in self.db.query("SELECT target FROM traceroute WHERE error IS NULL"
                                             " GROUP BY target HAVING MAX(ts) > ?", (cutoff,))}
        try:
            self.collect_traceroutes(skip=fresh)
        except Exception:
            log.exception("traceroute collector failed")

    def collect_traceroutes(self, skip=()):
        targets = [x for x in self.trace_targets() if x[0] not in skip]
        if not targets:
            return
        if not self.trace_lock.acquire(blocking=False):
            return  # previous round still running
        try:
            load_ix_prefixes(os.path.join(os.path.dirname(os.path.abspath(self.db.path)), "peeringdb-ix.json"))
            tr = self.cfg["traceroute"]
            isp = {c["connection"]: c["last_ok"] for c in isp_current(self)} if self.cfg["isp"]["enabled"] else {}
            conn_of_bind = {c["bind"]: c["name"] for c in self.cfg["connections"]}

            def one(item):
                tid, host, bind = item
                ts = time.time()
                try:
                    try:
                        dest = host if is_ip(host) else \
                            socket.getaddrinfo(host, None, socket.AF_INET if not bind or ":" not in bind else 0)[0][4][0]
                    except OSError:
                        dest = None
                    hops = traceroute(dest or host, tr["max_hops"], bind)
                    known = isp.get(conn_of_bind.get(bind, self.cfg["isp"]["main_name"])) or {}
                    isp_asn = int(known["asn"][2:]) if (known.get("asn") or "").startswith("AS") else None
                    kind, path, detailed = classify_route(hops, dest, isp_asn)
                    locate_hops(detailed, self.hop_geo, known.get("ip"))
                    return (ts, tid, dest, kind, json.dumps(path), json.dumps(detailed), None, host)
                except Exception as e:
                    return (ts, tid, None, None, None, None, str(e)[:200], host)
            with ThreadPoolExecutor(max_workers=int(tr["parallel"])) as pool:
                rows = list(pool.map(one, targets))
            self.db.insert_many("INSERT INTO traceroute (ts, target, dest, kind, path, hops, error, dest_host)"
                                " VALUES (?,?,?,?,?,?,?,?)", rows)
            log.info("traced %d routes", len(rows))
            load_as_relationships()  # used when routes are shown, so fetching it after tracing is fine
        finally:
            self.trace_lock.release()

    def collect_region_pings(self):
        ts = time.time()
        timeout = self.cfg["ping"]["timeout_seconds"]
        targets = [t for t in self.cfg["ping"]["targets"] if t["method"] == "region"]

        def probe(t):
            servers = [c for c in (self.region_servers(t["region"], wait=False) or []) if c["host"]]
            if not servers:
                return None
            t["host"] = f'{servers[0]["host"]}:{servers[0]["port"]}'
            return tcp_ping(servers[0]["host"], servers[0]["port"], timeout)
        results = list(self.pool.map(probe, targets))
        self.db.insert_many("INSERT INTO ping VALUES (?,?,?)",
                            [(ts, t["id"], r) for t, r in zip(targets, results) if t["host"] or r is not None])

    def collect_ping(self):
        ts = time.time()
        targets = [t for t in self.cfg["ping"]["targets"] if t["method"] != "region"]
        results = list(self.pool.map(self.ping_one, targets))
        self.db.insert_many("INSERT INTO ping VALUES (?,?,?)",
                            [(ts, t["id"], r) for t, r in zip(targets, results) if r is not SKIP])

    def collect_dns(self):
        ts = time.time()
        timeout = self.cfg["dns"]["timeout_seconds"]
        v6 = self.ipv6_available()  # don't record failures for IPv6 servers on an IPv4-only network
        jobs = [(s, d) for s in self.cfg["dns"]["servers"] for d in self.cfg["dns"]["domains"]
                if s["family"] == 4 or v6]
        results = list(self.pool.map(lambda j: dns_query(j[0]["host"], j[1], timeout), jobs))
        self.db.insert_many("INSERT INTO dns VALUES (?,?,?,?)",
                            [(ts, s["id"], d, r) for (s, d), r in zip(jobs, results)])

    def ipv6_available(self):
        if time.time() - self.ipv6[0] > 600:
            try:
                s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
                s.connect(("2606:4700:4700::1111", 53))  # no packets sent; fails without an IPv6 route
                s.close()
                ok = True
            except OSError:
                ok = False
            self.ipv6 = (time.time(), ok)
        return self.ipv6[1]

    def isp_connections(self):
        """(name, bind) for the main connection and every secondary connection."""
        return [(self.cfg["isp"]["main_name"], None)] + [(c["name"], c["bind"]) for c in self.cfg["connections"]]

    def collect_isp(self):
        def one(conn):
            name, bind = conn
            try:
                r = lookup_isp(bind)
                return (time.time(), name, r["ip"], r["isp"], r["asn"], r["location"], None)
            except Exception as e:
                return (time.time(), name, None, None, None, None, str(e)[:200])
        self.db.insert_many("INSERT INTO isp VALUES (?,?,?,?,?,?,?)", list(self.pool.map(one, self.isp_connections())))
        self.record_own_prefixes()

    def record_own_prefixes(self):
        """Remember every IPv6 /56 this machine has had, so the public dashboard keeps hiding old ones."""
        now = time.time()
        nets = {str(ipaddress.ip_network(f"{ip}/56", strict=False)) for ip in local_global_ipv6()}
        for (ip,) in self.db.query("SELECT DISTINCT ip FROM isp WHERE ip LIKE '%:%' AND ts > ?", (now - 3600,)):
            try:
                nets.add(str(ipaddress.ip_network(f"{ip}/56", strict=False)))
            except ValueError:
                pass
        self.db.insert_many("INSERT OR IGNORE INTO own_prefix VALUES (?, ?, ?)", [(n, now, now) for n in nets])
        self.db.insert_many("UPDATE own_prefix SET last_seen = ? WHERE prefix = ?", [(now, n) for n in nets])

    def collect_system(self):
        s = self.sys.sample()
        self.db.insert_many("INSERT INTO system VALUES (?,?,?,?,?,?)", [(
            s["ts"], s["cpu"],
            s["mem"]["percent"] if s["mem"] else None,
            s["disk"]["percent"] if s["disk"] else None,
            s["temp"],
            s["load"][0] if s["load"] else None,
        )])

    def rollup_all(self):
        now_m = int(time.time() // 60) * 60
        for spec in SERIES.values():
            start = self.db.scalar(f"SELECT MAX(ts) FROM {spec['rollup']}")
            if start is None:
                start = self.db.scalar(f"SELECT MIN(ts) FROM {spec['raw']}")
            if start is None:
                continue
            start = int(start // 60) * 60  # redo the newest minute in case it was incomplete
            while start < now_m:
                end = min(now_m, start + 86400)
                rollup(self.db, spec, start, end)
                start = end
            # hourly summaries from the minute table (the current hour is refreshed every minute)
            start = self.db.scalar(f"SELECT MAX(ts) FROM {spec['hourly']}")
            if start is None:
                start = self.db.scalar(f"SELECT MIN(ts) FROM {spec['rollup']}")
            if start is None:
                continue
            start = int(start // 3600) * 3600
            while start <= now_m:
                end = start + 30 * 86400
                rollup_hourly(self.db, spec, start, min(end, now_m + 60))
                start = end

    def cleanup(self):
        st = self.cfg["storage"]
        now = time.time()
        days = float(st["retention_days"])
        cutoff = now - days * 86400 if days > 0 else 0          # 0 = keep forever
        minute_cutoff = max(cutoff, now - float(st["minute_retention_days"]) * 86400)
        raw_cutoff = max(minute_cutoff, now - float(st["raw_retention_days"]) * 86400)
        for tables, cut in ((("ping", "dns"), raw_cutoff), (("ping_1m", "dns_1m"), minute_cutoff),
                            (("ping_1h", "dns_1h", "system", "speedtest", "isp", "traceroute"), cutoff)):
            if cut > 0:
                for table in tables:
                    self.db.conn().execute(f"DELETE FROM {table} WHERE ts < ?", (cut,))
        self.db.conn().execute("PRAGMA wal_checkpoint(TRUNCATE)")

    # -- speedtest
    def run_speedtest(self, blocking=True, scope="main"):
        """Run the main test(s) or the region tests. Tests always run one at a time."""
        if not self.st_lock.acquire(blocking=blocking):
            return False
        try:
            if scope == "regions":
                for region in self.cfg["speedtest"]["regions"]:
                    self._region_test(region)
            elif scope.startswith("conn:"):
                for conn in self.cfg["connections"]:
                    if conn["name"] == scope[5:]:
                        self._save_speedtest(time.time(), "connection", conn["name"],
                                             self._run_cli(None, conn["name"], conn["bind"]))
            else:
                for sid in (self.cfg["speedtest"]["servers"] or [None]):
                    self._save_speedtest(time.time(), "main", "Auto" if sid is None else f"Server {sid}",
                                         self._run_cli(sid, "Auto" if sid is None else f"Server {sid}"))
        finally:
            self.st_status = {"running": False}
            self.st_lock.release()
        return True

    def _region_test(self, region):
        name = region["name"]
        ts = time.time()
        servers = self.region_servers(region)
        if not servers:
            return self._save_speedtest(ts, "region", name, self._error_row(f"no reachable Ookla servers found for {name}"))
        row = None
        for c in servers[:3]:  # fastest first; fall back to the next server if one fails
            row = self._run_cli(c["id"], name)
            if not row["error"]:
                break
        self._save_speedtest(ts, "region", name, row)

    @staticmethod
    def _error_row(msg):
        row = dict.fromkeys(["server_id", "server_name", "server_location", "isp", "ping_ms", "jitter_ms",
                             "download_mbps", "upload_mbps", "packet_loss", "result_url", "data_bytes",
                             "server_host"])
        row["error"] = msg
        return row

    def _run_cli(self, server_id, label, bind=None):
        st = self.cfg["speedtest"]
        self.st_status = {"running": True, "label": label, "server_id": server_id, "started": time.time()}
        cmd = [st["binary"], "--format=json", "--accept-license", "--accept-gdpr"]
        if server_id:
            cmd += ["--server-id", str(server_id)]
        if bind:
            cmd += [f"--ip={bind}" if is_ip(bind) else f"--interface={bind}"]
        row = self._error_row(None)
        row["server_id"] = server_id
        log.info("running speedtest %s (server=%s)", label, server_id or "auto")
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=st["timeout_seconds"],
                               **SUBPROCESS_FLAGS)
            result, err = None, None
            for line in (p.stdout + "\n" + p.stderr).splitlines():
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if obj.get("type") == "result":
                    result = obj
                elif obj.get("level") == "error":
                    err = obj.get("message")
            if result:
                srv = result.get("server", {})
                row.update(
                    server_id=srv.get("id"), server_name=srv.get("name"),
                    server_location=srv.get("location"), isp=result.get("isp"),
                    ping_ms=result.get("ping", {}).get("latency"),
                    jitter_ms=result.get("ping", {}).get("jitter"),
                    download_mbps=result["download"]["bandwidth"] * 8 / 1e6,
                    upload_mbps=result["upload"]["bandwidth"] * 8 / 1e6,
                    packet_loss=result.get("packetLoss"),
                    result_url=result.get("result", {}).get("url"),
                    server_host=str(srv.get("host") or "").rsplit(":", 1)[0] or None,
                    data_bytes=(result["download"].get("bytes") or 0) + (result["upload"].get("bytes") or 0),
                )
            else:
                row["error"] = err or p.stderr.strip()[-500:] or f"speedtest exited with code {p.returncode}"
        except FileNotFoundError:
            row["error"] = f"speedtest binary not found at {st['binary']}"
        except OSError as e:  # e.g. permission denied
            row["error"] = f"could not run {st['binary']}: {e}"
        except subprocess.TimeoutExpired:
            row["error"] = "speedtest timed out"
        if row["error"]:
            log.warning("speedtest %s failed: %s", label, row["error"])
        return row

    def _save_speedtest(self, ts, kind, label, row):
        cols = ["ts", "kind", "label"] + list(row)
        self.db.insert_many(f"INSERT INTO speedtest ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                            [[ts, kind, label] + list(row.values())])

    # -- api helpers
    def target_name(self, tid):
        for t in self.cfg["ping"]["targets"]:
            if t["id"] == tid:
                return t["name"]
        return tid


# --------------------------------------------------------------------------- API

NICE_BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
                2 * 86400, 7 * 86400]


def q_time(q, key, default):
    """A Unix time from the query string: a finite number, kept between 1970 and tomorrow."""
    v = q.get(key)
    if v in (None, ""):
        return default
    try:
        t = float(v)
    except ValueError:
        t = math.nan
    if not math.isfinite(t):
        raise ValueError(f"'{key}' must be a Unix time in seconds")
    return min(max(t, 0.0), time.time() + 86400)


def q_int(q, key, default, lo, hi):
    try:
        return max(lo, min(hi, int(q.get(key) or default)))
    except ValueError:
        raise ValueError(f"'{key}' must be a whole number") from None


def parse_range(q, base_interval):
    now = time.time()
    to = q_time(q, "to", now)
    frm = q_time(q, "from", to - 3600)
    if frm >= to:
        raise ValueError("'from' must be before 'to'")
    points = q_int(q, "points", 500, 20, 2000)
    raw = max(base_interval, (to - frm) / points)
    bucket = next((b for b in NICE_BUCKETS if b >= raw), raw)
    return frm, to, bucket


def split_list(v):
    return [x for x in (v or "").split(",") if x]


def aggregate(m, name, frm, to, bucket, keys=None, extra=("", ())):
    """Rows of (key, bucket, n, ok, avg, min, max, p5, p95). bucket=None aggregates the whole range."""
    spec = SERIES[name]
    key = spec["keys"][0]
    st, now = m.cfg["storage"], time.time()
    span = to - frm
    # raw samples for short ranges, 1-minute summaries for days, hourly summaries for months/years
    if bucket is None:
        level = "hourly" if span > 31 * 86400 else "rollup" if span > ROLLUP_ABOVE_SECONDS else "raw"
    else:
        level = "hourly" if bucket >= 3600 else "rollup" if bucket >= 60 else "raw"
    if frm < now - float(st["minute_retention_days"]) * 86400:
        level = "hourly"
    elif level == "raw" and frm < now - float(st["raw_retention_days"]) * 86400:
        level = "rollup"
    bexpr = "0" if bucket is None else f"CAST(ts / {float(bucket)!r} AS INTEGER)"
    where, params = "ts >= ? AND ts <= ?", [frm, to]
    if keys:
        where += f" AND {key} IN ({','.join('?' * len(keys))})"
        params += keys
    if extra[0]:
        where += " AND " + extra[0]
        params += list(extra[1])
    if level == "raw":
        return m.db.query(pct_select(spec["val"], bexpr, [key], spec["raw"], where) + " ORDER BY b", params)
    # Combine summary rows: exact count/min/max, sample-weighted avg, and P5/P95 from the added-up
    # histograms. Rows from before histograms existed fall back to weighted per-row percentiles.
    sql = (f"SELECT {key}, {bexpr} AS b, {COMBINE}, {HIST_SUMS} FROM {spec[level]} WHERE {where}"
           f" GROUP BY {key}, b ORDER BY b")
    out = []
    for row in m.db.query(sql, params):
        k, b, n, ok, avg, mn, mx, p5, p95 = row[:9]
        counts = [c or 0 for c in row[9:]]
        if ok and sum(counts) == ok:
            p5, p95 = hist_percentile(counts, 0.05, mn, mx), hist_percentile(counts, 0.95, mn, mx)
        out.append((k, b, n, ok, avg, mn, mx, p5, p95))
    return out


def latency_series(m, name, frm, to, bucket, keys=None, extra=("", ())):
    series = {}
    for k, b, n, ok, avg, mn, mx, p5, p95 in aggregate(m, name, frm, to, bucket, keys, extra):
        series.setdefault(k, []).append(
            [int(b * bucket * 1000), r2(avg), r2(mn), r2(mx), round(100.0 * (n - ok) / n, 2), r2(p5), r2(p95)])
    stats = {k: {"avg": r2(avg), "min": r2(mn), "max": r2(mx), "p5": r2(p5), "p95": r2(p95), "samples": n,
                 "loss": round(100.0 * (n - ok) / n, 2)}
             for k, _, n, ok, avg, mn, mx, p5, p95 in aggregate(m, name, frm, to, None, keys, extra)}
    return series, stats


def r2(v):
    return None if v is None else round(v, 2)


def api_config(m, q):
    c = m.cfg
    return {
        "version": VERSION,
        "repo": REPO_URL,
        "info": m.static_info,
        "ping": {"interval_seconds": c["ping"]["interval_seconds"], "offset_seconds": c["ping"]["offset_seconds"],
                 "region_interval_seconds": c["ping"]["region_interval_seconds"],
                 "ipv6": c["ping"]["ipv6"] and m.ipv6_available(),
                 "targets": [{k: v for k, v in t.items() if k != "region"} for t in c["ping"]["targets"]
                             if t.get("family") != 6 or m.v6_live(t)]},
        "dns": {"enabled": c["dns"]["enabled"], "interval_seconds": c["dns"]["interval_seconds"],
                "servers": c["dns"]["servers"], "domains": c["dns"]["domains"],
                "ipv6_available": m.ipv6_available()},
        "connections": [{"name": x["name"], "bind": x["bind"], "speedtest": x["speedtest"],
                         "speedtest_interval_minutes": x["speedtest_interval_minutes"]} for x in c["connections"]],
        "speedtest": {"enabled": c["speedtest"]["enabled"], "manual": c["speedtest"]["manual"], "interval_minutes": c["speedtest"]["interval_minutes"],
                      "offset_minutes": c["speedtest"]["offset_minutes"], "servers": c["speedtest"]["servers"],
                      "next_run": next_aligned(c["speedtest"]["interval_minutes"] * 60,
                                               c["speedtest"]["offset_minutes"] * 60)
                      if c["speedtest"]["enabled"] else None,
                      "regions": [r["name"] for r in c["speedtest"]["regions"]],
                      "flags": {r["name"]: r.get("flag", "") for r in c["speedtest"]["regions"] + c["ping"]["regions"]},
                      "regions_interval_minutes": c["speedtest"]["regions_interval_minutes"],
                      "next_regions_run": next_aligned(c["speedtest"]["regions_interval_minutes"] * 60,
                                                       c["speedtest"]["regions_offset_minutes"] * 60)
                      if c["speedtest"]["enabled"] and c["speedtest"]["regions"] else None},
        "system": {"interval_seconds": c["system"]["interval_seconds"]},
        "isp": {"enabled": c["isp"]["enabled"], "connections": [n for n, _ in m.isp_connections()]},
        "docker_bridge": m.docker_bridge,
        "retention_days": c["storage"]["retention_days"],
        "storage": {k: v for k, v in c["storage"].items() if k != "database"},
    }


def api_ping(m, q):
    frm, to, bucket = parse_range(q, m.cfg["ping"]["interval_seconds"])
    series, stats = latency_series(m, "ping", frm, to, bucket, split_list(q.get("targets")))
    return {"from": frm, "to": to, "bucket": bucket, "series": series, "stats": stats}


def api_dns(m, q):
    frm, to, bucket = parse_range(q, m.cfg["dns"]["interval_seconds"])
    domain = q.get("domain")
    extra = ("domain = ?", (domain,)) if domain else ("", ())
    series, stats = latency_series(m, "dns", frm, to, bucket, split_list(q.get("servers")), extra)
    return {"from": frm, "to": to, "bucket": bucket, "series": series, "stats": stats}


def api_speedtest(m, q):
    now = time.time()
    to = q_time(q, "to", now)
    frm = q_time(q, "from", to - 7 * 86400)
    cols = ["ts", "kind", "label", "server_id", "server_name", "server_location", "isp", "ping_ms", "jitter_ms",
            "download_mbps", "upload_mbps", "packet_loss", "data_bytes", "result_url", "error"]
    rows = m.db.query(f"SELECT ts, COALESCE(kind, 'main'), COALESCE(label, 'Auto'), {','.join(cols[3:])}"
                      " FROM speedtest WHERE ts >= ? AND ts <= ? ORDER BY ts", (frm, to))
    return {"from": frm, "to": to, "results": [dict(zip(cols, r)) for r in rows], "status": m.st_status}


def api_system(m, q):
    s = m.sys.latest or m.sys.sample()
    db_size = sum(os.path.getsize(m.db.path + ext) for ext in ("", "-wal") if os.path.exists(m.db.path + ext))
    return dict(s, info=m.static_info, uptime=m.sys.uptime(), ip=m.sys.primary_ip(),
                db_size=db_size, netbae_uptime=time.time() - m.started)


def api_system_history(m, q):
    frm, to, bucket = parse_range(q, m.cfg["system"]["interval_seconds"])
    rows = m.db.query(
        "SELECT CAST(ts / ? AS INTEGER) b, AVG(cpu), AVG(mem), AVG(disk), AVG(temp), AVG(load1)"
        " FROM system WHERE ts >= ? AND ts <= ? GROUP BY b ORDER BY b", (bucket, frm, to))
    keys = ["cpu", "mem", "disk", "temp", "load1"]
    series = {k: [] for k in keys}
    for b, *vals in rows:
        for k, v in zip(keys, vals):
            series[k].append([int(b * bucket * 1000), r2(v)])
    return {"from": frm, "to": to, "bucket": bucket, "series": series}


def isp_current(m):
    """Latest ISP check per connection, plus the last successful one if the latest failed."""
    out = []
    for name, _ in m.isp_connections():
        rows = m.db.query("SELECT ts, ip, isp, asn, location, error FROM isp WHERE connection = ?"
                          " ORDER BY ts DESC LIMIT 1", (name,))
        good = m.db.query("SELECT ts, ip, isp, asn, location FROM isp WHERE connection = ? AND error IS NULL"
                          " ORDER BY ts DESC LIMIT 1", (name,))
        latest = dict(zip(["ts", "ip", "isp", "asn", "location", "error"], rows[0])) if rows else None
        ok = dict(zip(["ts", "ip", "isp", "asn", "location"], good[0])) if good else None
        out.append({"connection": name, "latest": latest, "last_ok": ok})
    return out


def latest_routes(m):
    """Latest successful route per target: {id: {ts, kind, path, cities}}."""
    out = {}
    for tid, ts, kind, path, hops in m.db.query(
            "SELECT target, MAX(ts), kind, path, hops FROM traceroute WHERE error IS NULL GROUP BY target"):
        detailed = locate_hops(json.loads(hops or "[]"))
        out[tid] = {"ts": ts, "kind": kind, "path": with_rels(json.loads(path or "[]")),
                    "cities": route_cities(detailed),  # the public dashboard may hide the first hops' cities
                    "public_cities": route_cities(PublicMask.hide_home_hops(detailed))}
    return out


def api_traceroute(m, q):
    """Full hop list for one target's latest route, plus its route history."""
    tid = q.get("target") or ""
    rows = m.db.query("SELECT ts, dest, kind, path, hops, error, dest_host FROM traceroute WHERE target = ?"
                      " ORDER BY ts DESC LIMIT 30", (tid,))
    hist = [{"ts": ts, "dest": dest, "dest_host": dh, "kind": kind, "path": with_rels(json.loads(path or "[]")),
             "hops": locate_hops(json.loads(hops or "[]")) if i == 0 else None, "error": err}
            for i, (ts, dest, kind, path, hops, err, dh) in enumerate(rows)]
    return {"target": tid, "latest": hist[0] if hist else None, "history": hist, "rel_source": as_rel_serial()}


def api_isp(m, q):
    """ISP observations in a range: every change, plus at most one sample per bucket."""
    now = time.time()
    to = q_time(q, "to", now)
    frm = q_time(q, "from", to - 86400)
    points = q_int(q, "points", 300, 20, 2000)
    gap = (to - frm) / points
    series = {}
    keep = {}
    for ts, conn, ip, isp, asn, err in m.db.query(
            "SELECT ts, connection, ip, isp, asn, error FROM isp WHERE ts >= ? AND ts <= ? ORDER BY ts", (frm, to)):
        key = (isp, ip, bool(err))
        last = keep.get(conn)
        changed = last is not None and last[1] != key
        if last is None or changed or ts - last[0] >= gap:
            keep[conn] = (ts, key)
            series.setdefault(conn, []).append(
                [int(ts * 1000), isp or ("check failed" if err else None), ip, asn, changed])
    return {"from": frm, "to": to, "series": series}


def api_summary(m, q):
    now = time.time()
    last = {t: (rtt, ts) for t, rtt, ts in m.db.query(
        "SELECT target, rtt, MAX(ts) FROM ping WHERE ts > ? GROUP BY target", (now - 120,))}
    recent = {}
    for t, rtt in m.db.query("SELECT target, rtt FROM ping WHERE ts > ?", (now - 300,)):
        recent.setdefault(t, []).append(rtt)
    agg = {t: (trimmed_mean(v), len(v), sum(x is not None for x in v)) for t, v in recent.items()}
    ping = []
    for t in m.cfg["ping"]["targets"]:
        l = last.get(t["id"], (None, None))
        a = agg.get(t["id"])
        if t.get("family") == 6 and not a and not m.v6_live(t):
            continue  # this site (or this network) has no IPv6
        ping.append({"id": t["id"], "name": t["name"], "host": t.get("display") or t["host"], "method": t["method"],
                     "group": t["group"], "flag": t.get("flag", ""), "connection": t.get("connection"),
                     "family": t.get("family"), "twin": t.get("twin"),
                     "where": t.get("where") or ("finding nearest server…" if t["method"] == "game" else None),
                     "last": r2(l[0]), "last_ts": l[1],
                     "avg5m": r2(a[0]) if a else None,
                     "loss5m": round(100.0 * (a[1] - a[2]) / a[1], 1) if a else None})
    recent = {}
    for sv, ms in m.db.query("SELECT server, ms FROM dns WHERE ts > ?", (now - 300,)):
        recent.setdefault(sv, []).append(ms)
    dns = {sv: {"avg5m": r2(trimmed_mean(v)), "fail5m": round(100.0 * sum(x is None for x in v) / len(v), 1)}
           for sv, v in recent.items()}
    main = "COALESCE(kind, 'main') = 'main'"
    ok = m.db.query(f"SELECT {','.join(ST_COLS)} FROM speedtest WHERE {main} AND error IS NULL ORDER BY ts DESC LIMIT 1")
    latest = m.db.query(f"SELECT {','.join(ST_COLS)} FROM speedtest WHERE {main} ORDER BY ts DESC LIMIT 1")
    averages = {label: st_avg(m, main, (), now - span) for label, span in (("24h", 86400), ("7d", 7 * 86400))}
    regions = st_by_label(m, "region", now)
    conns = st_by_label(m, "connection", now)
    flags = {r["name"]: r.get("flag", "") for r in m.cfg["speedtest"]["regions"]}
    return {
        "now": now, "ping": ping, "dns": dns, "isp": isp_current(m), "routes": latest_routes(m),
        "speedtest": {
            "last_ok": dict(zip(ST_COLS, ok[0])) if ok else None,
            "latest": dict(zip(ST_COLS, latest[0])) if latest else None,
            "averages": averages,
            "regions": [dict(regions.get(r["name"], {}), name=r["name"], flag=flags.get(r["name"], ""))
                        for r in m.cfg["speedtest"]["regions"]],
            "regions_avg": {label: st_avg(m, "kind = 'region'", (), now - span)
                            for label, span in (("24h", 86400), ("7d", 7 * 86400))},
            "connections": [dict(conns.get(c["name"], {}), name=c["name"]) for c in m.cfg["connections"]],
            "status": m.st_status,
        },
    }


ST_COLS = ["ts", "server_name", "server_location", "isp", "ping_ms", "jitter_ms", "download_mbps", "upload_mbps",
           "packet_loss", "data_bytes", "result_url", "error"]


def st_avg(m, where, params, since):
    """Averages of successful speedtests since a time, plus total data used (failed tests included)."""
    rows = m.db.query("SELECT download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss"
                      f" FROM speedtest WHERE {where} AND error IS NULL AND ts > ?", (*params, since))
    n = len(rows)

    def avg(i):  # each metric's average without its outliers (e.g. one test that hit a congested server)
        v = outlier_free(r[i] for r in rows) if i < 4 else [r[i] for r in rows if r[i] is not None]  # keep every loss value
        return sum(v) / len(v) if v else None
    dl, ul, pg, jt, pl = (avg(i) for i in range(5))
    data = m.db.scalar(f"SELECT SUM(data_bytes) FROM speedtest WHERE {where} AND ts > ?", (*params, since))
    return {"tests": n, "download_mbps": r2(dl), "upload_mbps": r2(ul), "ping_ms": r2(pg), "jitter_ms": r2(jt),
            "packet_loss": r2(pl), "data_bytes": data or 0}


def st_by_label(m, kind, now):
    """Latest result (ok or failed), last good result and 7-day averages for each label of a kind."""
    out = {}
    for lbl, *vals, _ in m.db.query(
            f"SELECT label, {','.join(ST_COLS)}, MAX(ts) FROM speedtest WHERE kind = ? GROUP BY label", (kind,)):
        out[lbl] = dict(zip(ST_COLS, vals))
        out[lbl]["avg7d"] = st_avg(m, "kind = ? AND label = ?", (kind, lbl), now - 7 * 86400)
        out[lbl]["avg24h"] = st_avg(m, "kind = ? AND label = ?", (kind, lbl), now - 86400)
        good = m.db.query(f"SELECT {','.join(ST_COLS)} FROM speedtest WHERE kind = ? AND label = ? AND error IS NULL"
                          " ORDER BY ts DESC LIMIT 1", (kind, lbl))
        out[lbl]["last_ok"] = dict(zip(ST_COLS, good[0])) if good else None
    return out


def find_program(name, *extra):
    """A program on the PATH or in one of the usual install places."""
    found = shutil.which(name)
    if found:
        return found
    return next((x for x in extra if os.path.isfile(x)), None)


def local_json(port, path, timeout=1.5):
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        conn.request("GET", path)
        r = conn.getresponse()
        body = r.read()
        conn.close()
        return json.loads(body) if r.status == 200 else None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def tunnel_status(m):
    """Tunnels pointing at the public dashboard: cloudflared (through its metrics server, on
    127.0.0.1:20241-20245 by default) and Tailscale Funnel, each checked from outside."""
    port = int(m.cfg["public"]["port"])
    tunnels = []
    for mport in range(20241, 20246):
        ready = local_json(mport, "/ready")
        if ready is None:
            continue
        connected = (ready.get("readyConnections") or 0) > 0
        quick = (local_json(mport, "/quicktunnel") or {}).get("hostname")
        if quick:
            tunnels.append({"kind": "Cloudflare quick tunnel", "url": f"https://{quick}", "connected": connected})
            continue
        hosts = []
        cfg = (local_json(mport, "/config") or {}).get("config") or {}
        for rule in cfg.get("ingress") or []:  # tunnels configured in the Cloudflare dashboard
            if rule.get("hostname") and f":{port}" in str(rule.get("service", "")):
                hosts.append(rule["hostname"])
        tunnels.append({"kind": "Cloudflare Tunnel", "url": f"https://{hosts[0]}" if hosts else None,
                        "connected": connected, "metrics": mport})
    # netbae tunnel's own config names the hostname of a tunnel on your domain
    yml = os.path.join(os.path.dirname(m.config_path or DEFAULT_CONFIG_PATH), "cloudflared", "config.yml")
    host = next(iter(re.findall(r"^\s*- hostname: *(\S+)", read_file(yml) or "", re.M)), None)
    if host:
        named = next((t for t in tunnels if t["kind"] == "Cloudflare Tunnel" and not t["url"]), None)
        if named:
            named["url"] = f"https://{host}"
        elif not any(t["url"] == f"https://{host}" for t in tunnels):
            tunnels.append({"kind": "Cloudflare Tunnel", "url": f"https://{host}", "connected": False})
    ts = find_program("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                      os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Tailscale", "tailscale.exe"))
    if ts:
        try:
            out = subprocess.run([ts, "funnel", "status"], capture_output=True, text=True, timeout=8,
                                 errors="replace").stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        if re.search(rf"(127\.0\.0\.1|localhost):{port}\b", out):
            url = next(iter(re.findall(r"(https://\S+?)(?::443)? \(Funnel on\)", out)), None)
            tunnels.append({"kind": "Tailscale Funnel", "url": url, "connected": bool(url)})
    for t in tunnels:  # can the internet actually reach it?
        t["reachable"] = False
        if t.get("url"):
            try:
                req = urllib.request.Request(t["url"] + "/api/config", headers={"User-Agent": f"netBae/{VERSION}"})
                with urllib.request.urlopen(req, timeout=8) as r:
                    t["reachable"] = '"public":true' in r.read(1 << 20).decode(errors="replace")
            except Exception:
                pass
        t.pop("metrics", None)
    return tunnels


def api_sharing(m, q):
    """Private dashboard only: is the public dashboard on, which tunnels reach it, how many visitors."""
    pub = m.cfg["public"]
    now = time.time()
    with m.share_lock:
        stale = now - m.share_ts > (20 if q.get("fresh") else 120)
        if pub["enabled"] and stale and not m.share_busy:
            m.share_busy = True

            def refresh():
                try:
                    m.share = {"tunnels": tunnel_status(m)}
                except Exception:
                    log.exception("tunnel status check failed")
                finally:
                    m.share_ts, m.share_busy = time.time(), False
            threading.Thread(target=refresh, name="tunnel-status", daemon=True).start()
        share = dict(m.share)
    return dict(share, enabled=pub["enabled"], port=pub["port"], host=pub["host"], checked=m.share_ts or None,
                checking=m.share_busy, visitors_1h=sum(1 for t in list(m.public_visitors.values()) if now - t < 3600),
                visitors_24h=sum(1 for t in list(m.public_visitors.values()) if now - t < 86400),
                direct_ts=m.public_direct_ts)


def api_run_speedtest(m, q):
    if not m.cfg["speedtest"]["manual"]:
        return {"started": False, "reason": "manual speedtests are turned off in the config ([speedtest] manual)"}
    if m.st_lock.locked():
        return {"started": False, "reason": "a speedtest is already running"}
    scope = q.get("scope") or "main"
    if scope == "regions" and not m.cfg["speedtest"]["regions"]:
        return {"started": False, "reason": "no regions configured"}
    if scope.startswith("conn:") and scope[5:] not in [c["name"] for c in m.cfg["connections"]]:
        return {"started": False, "reason": "unknown connection"}
    if scope not in ("main", "regions") and not scope.startswith("conn:"):
        return {"started": False, "reason": "unknown scope"}
    threading.Thread(target=m.run_speedtest, kwargs={"blocking": False, "scope": scope}, daemon=True).start()
    return {"started": True}


# --------------------------------------------------------------------------- public dashboard

_IP_RE = re.compile(r"(?<!\d)(?<!\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\d)(?!\.\d)"
                    r"|(?<![\w:])[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?![\w:])")


V6_MATCH = 48  # IPv6 addresses in the same /48 as one of yours count as yours (ISPs hand out /48 to /64)


class PublicMask:
    """Hides you in public responses: the last half of your public IPv4 addresses, everything after
    the ISP's /32 for IPv6 addresses in any /48 you've had, hostnames on your own domains or carrying
    your addresses, the names of hops inside your network, this machine's name and your city.
    [public] hide adds more addresses, prefixes or domains."""

    def __init__(self, m):
        self.m, self.loaded, self.v4, self.v4nets, self.v6 = m, 0, set(), [], []
        self.domains, self.extra_domains, self.domains_loaded, self.needles, self.names = [], [], 0, [], []
        self.show_host, self.show_city = m.cfg["public"]["show_hostname"], m.cfg["public"]["show_city"]
        self.lock = threading.Lock()
        self.back = {}  # masked -> original, so an id containing your address still works in queries

    def refresh(self):
        with self.lock:
            now = time.time()
            if now - self.loaded < 60:
                return
            v4, v4nets, v6 = set(), [], set()
            ips = [r[0] for r in self.m.db.query("SELECT DISTINCT ip FROM isp WHERE ip IS NOT NULL")]
            ips += local_global_ipv6()
            for (pfx,) in self.m.db.query("SELECT prefix FROM own_prefix"):
                v6.add(ipaddress.ip_network(pfx).supernet(new_prefix=V6_MATCH))
            extra_domains = []
            for item in self.m.cfg["public"].get("hide") or []:
                try:
                    net = ipaddress.ip_network(str(item).strip(), strict=False)
                except ValueError:
                    extra_domains.append(str(item).strip().lower().strip("."))
                    continue
                if net.version == 4:
                    v4nets.append(net)
                else:  # a single IPv6 address hides its whole /48
                    v6.add(net if net.prefixlen <= V6_MATCH else net.supernet(new_prefix=V6_MATCH))
            for ip in ips:
                try:
                    a = ipaddress.ip_address(str(ip).split("%")[0])
                except ValueError:
                    continue
                if not a.is_global:
                    continue
                if a.version == 4:
                    v4.add(str(a))
                else:
                    v6.add(ipaddress.ip_network(f"{a}/{V6_MATCH}", strict=False))
            if now - self.domains_loaded > 600:
                self.domains = sorted(self.find_domains(), key=len, reverse=True)
                self.domains_loaded = now
            self.extra_domains = [d for d in extra_domains if d]
            # your addresses as ISPs write them inside hostnames
            needles = set()
            for ip in v4:
                o = ip.split(".")
                needles.update({"-".join(o), "_".join(o), "-".join(o[::-1]), ".".join(o[::-1]) + ".",
                                "".join(x.zfill(3) for x in o), "".join(f"{int(x):02x}" for x in o)})
            for n in v6:  # e.g. 2401-d002-3914-..., 2401d0023914...
                h = n.network_address.exploded.split(":")[:3]
                needles.update({"-".join(h), "-".join(x.lstrip("0") or "0" for x in h) + "-", "".join(h)})
            host = self.m.static_info.get("hostname") or ""
            names = {host, host.split(".")[0], socket.gethostname(), socket.gethostname().split(".")[0]}
            self.names = [] if self.show_host else sorted((x for x in names if len(x) >= 3), key=len, reverse=True)
            self.v4, self.v4nets, self.v6, self.needles, self.loaded = v4, v4nets, list(v6), sorted(needles), now

    def find_domains(self):
        """Your own domains: from the router's and this machine's names, the DNS search domains,
        and the names of hops inside your network."""
        names = local_search_domains()
        names += [reverse_dns(ip) for ip in (default_gateway(), SystemStats.primary_ip()) if ip]
        for (hops,) in self.m.db.query("SELECT hops FROM traceroute WHERE hops IS NOT NULL ORDER BY ts DESC LIMIT 100"):
            for h in json.loads(hops or "[]")[:4]:
                if h.get("host") and not self.is_public_ip(h.get("ip")):
                    names.append(h["host"])
        return {d for d in map(site_domain, names) if d}

    @staticmethod
    def is_public_ip(ip):
        try:
            return ipaddress.ip_address(str(ip).split("%")[0]).is_global
        except ValueError:
            return False

    def _ip(self, mt):
        txt = mt.group(0)
        try:
            a = ipaddress.ip_address(txt)
        except ValueError:
            return txt
        if a.version == 4 and (str(a) in self.v4 or any(a in n for n in self.v4nets)):
            out = ".".join(txt.split(".")[:2] + ["x", "x"])
        elif a.version == 6 and any(a in n for n in self.v6):
            out = ":".join(a.exploded.split(":")[:2] + ["x"] * 6)
        else:
            return txt
        self.back[out] = txt
        return out

    def text(self, v):
        orig = v
        v = _IP_RE.sub(self._ip, v)
        for ip in self.v4:  # hostnames like 203-0-113-5.isp.example
            dashed = ip.replace(".", "-")
            if dashed in v:
                v = v.replace(dashed, "-".join(ip.split(".")[:2] + ["x", "x"]))
        low = v.lower()
        for d in self.domains + self.extra_domains:  # any name on your own domain
            if d in low:
                v = re.sub(r"(?<![\w-])(?:[\w-]+\.)*" + re.escape(d) + r"(?![\w-])", "(hidden)", v, flags=re.I)
                low = v.lower()
        for needle in self.needles:  # hostnames carrying your addresses
            if needle in low:
                v = re.sub(r"[\w.-]*" + re.escape(needle) + r"[\w.-]*", "(hidden)", v, flags=re.I)
                low = v.lower()
        for name in self.names:  # this machine's name
            if name.lower() in low:
                v = re.sub(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", "(hidden)", v, flags=re.I)
                low = v.lower()
        if v != orig:
            self.back[v] = orig
        return v

    @classmethod
    def hide_home_hops(cls, hops):
        """Without show_city: drop the route's first city, which is yours. Public hops up to the last one in
        that city lose their city and hostname (routers there are often named after it)."""
        first = next((h.get("city") for h in hops if isinstance(h, dict) and h.get("city")), None)
        last = max((i for i, h in enumerate(hops) if isinstance(h, dict) and first and h.get("city") == first), default=-1)
        return [dict(h, city=None, city_src=None, host=None) if i <= last and cls.is_public_ip(h.get("ip")) else h
                for i, h in enumerate(hops)]

    def unmask(self, q):
        """Query parameters from the public page back to the real ids."""
        return {k: ",".join(self.back.get(x, x) for x in v.split(",")) for k, v in q.items()}

    def apply(self, obj):
        self.refresh()
        return self._walk(obj)

    def _walk(self, o):
        if isinstance(o, str):
            return self.text(o)
        if isinstance(o, dict):
            if "ip" in o and "host" in o and o.get("host") and not self.is_public_ip(o.get("ip")):
                o = dict(o, host=None)  # a hop inside your network: its name says who you are
            if "hostname" in o and not self.show_host:
                o = dict(o, hostname=None)
            if "location" in o and "isp" in o and o.get("location") and not self.show_city:
                o = dict(o, location=o["location"].split(",")[-1].strip())  # "Melbourne, AU" -> "AU"
            if "public_cities" in o:  # a route summary
                o = dict(o, cities=o["cities"] if self.show_city else o["public_cities"])
                del o["public_cities"]
            if not self.show_city and isinstance(o.get("hops"), list):
                o = dict(o, hops=self.hide_home_hops(o["hops"]))
            return {self.text(k) if isinstance(k, str) else k: self._walk(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [self._walk(v) for v in o]
        return o


class RateLimiter:
    """Token buckets: one per visitor plus one shared by everyone, each refilled per minute."""

    def __init__(self, per_client, total):
        self.per_client, self.total = max(1, int(per_client)), max(1, int(total))
        self.buckets, self.all, self.lock = {}, [float(self.total), time.monotonic()], threading.Lock()

    @staticmethod
    def _take(b, cap, now):
        b[0] = min(cap, b[0] + (now - b[1]) * cap / 60.0)
        b[1] = now
        if b[0] < 1:
            return (1 - b[0]) * 60.0 / cap  # seconds until the next request is allowed
        b[0] -= 1
        return 0

    def check(self, client):
        """0 if the request may go ahead, else the seconds to wait."""
        now = time.monotonic()
        with self.lock:
            if len(self.buckets) > 10000:  # forget visitors whose bucket has refilled
                self.buckets = {k: b for k, b in self.buckets.items() if now - b[1] < 60}
            b = self.buckets.setdefault(client, [float(self.per_client), now])
            wait_s = self._take(b, self.per_client, now)
            if wait_s:
                return wait_s
            wait_s = self._take(self.all, self.total, now)
            if wait_s:
                b[0] += 1  # not this visitor's fault
            return wait_s


GET_ROUTES = {
    "/api/config": api_config, "/api/ping": api_ping, "/api/dns": api_dns,
    "/api/speedtest": api_speedtest, "/api/system": api_system,
    "/api/system/history": api_system_history, "/api/summary": api_summary, "/api/isp": api_isp,
    "/api/traceroute": api_traceroute,
}
POST_ROUTES = {"/api/speedtest/run": api_run_speedtest}
PRIVATE_ROUTES = dict(GET_ROUTES, **{"/api/sharing": api_sharing})  # not on the public dashboard
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                 ".json": "application/json", ".ico": "image/x-icon"}


def make_handler(monitor, public=False):
    pcfg = monitor.cfg["public"]
    limiter = RateLimiter(pcfg["requests_per_minute"], pcfg["total_requests_per_minute"]) if public else None
    mask = PublicMask(monitor) if public else None
    busy = threading.BoundedSemaphore(32)  # public: at most this many requests worked on at once
    direct_warned = [0.0]

    class Handler(BaseHTTPRequestHandler):
        server_version = f"netbae/{VERSION}"
        timeout = 20 if public else None  # public: drop connections that stall mid-request

        def client_id(self):
            a = peer_ip(self.client_address[0])
            peer = str(a) if a else self.client_address[0]
            if a and a.is_private:  # a tunnel or reverse proxy on your network: rate-limit the real visitor
                fwd = (self.headers.get("CF-Connecting-IP") or self.headers.get("X-Real-IP")
                       or (self.headers.get("X-Forwarded-For") or "").split(",")[0]).strip()
                if fwd:
                    return fwd
            return peer

        def warn_direct(self):
            """Visitors arriving straight from the internet mean the port is forwarded, not tunnelled."""
            a = peer_ip(self.client_address[0])
            if a and a.is_global:
                mask.refresh()
                if str(a) in mask.v4 or any(a in n for n in mask.v6):
                    return  # your own network, reaching this machine on its public IPv6 address
            if a and a.is_global:
                monitor.public_direct_ts = time.time()
            if a and a.is_global and time.time() - direct_warned[0] > 3600:
                direct_warned[0] = time.time()
                log.warning("public dashboard: a visitor (%s) reached port %d straight from the internet, so the port "
                            "is forwarded on your router and visitors see your full IP address. Use a Cloudflare "
                            "Tunnel or Tailscale Funnel instead (see the README) and remove the port forward.",
                            a, self.server.server_address[1])

        def public_gate(self):
            """Public dashboard: True if this request may go ahead (else a reply was sent)."""
            mask.refresh()
            self.warn_direct()
            cid = self.client_id()
            a = peer_ip(cid)
            if not (a and (str(a) in mask.v4 or any(a in n for n in mask.v6))):  # not you (e.g. the tunnel check)
                v = monitor.public_visitors
                if len(v) > 20000:
                    for k in [k for k, t in list(v.items()) if time.time() - t > 86400]:
                        v.pop(k, None)
                v[cid] = time.time()
            wait_s = limiter.check(cid)
            if wait_s:
                self.send_json({"error": "too many requests, slow down"}, 429, {"Retry-After": str(math.ceil(wait_s))})
                return False
            return True

        def log_message(self, fmt, *args):
            log.debug("%s - %s", self.address_string(), fmt % args)

        def end_headers(self):
            if public:
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Frame-Options", "DENY")
            super().end_headers()

        def send_json(self, obj, status=200, headers=None):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def dispatch(self, routes):
            u = urlparse(self.path)
            q = {k: v[-1] for k, v in parse_qs(u.query).items()}
            fn = routes.get(u.path)
            if fn is None:
                return False
            try:
                out = fn(monitor, mask.unmask(q) if public else q)
                if public:
                    if u.path == "/api/config":
                        out = dict(out, public=True)
                    out = mask.apply(out)
                self.send_json(out)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the browser went away (reload, closed tab) before the reply was sent
            except ValueError as e:
                self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log.exception("API error on %s", self.path)
                # the public port never shows internal details (paths, addresses) in an error
                self.send_json({"error": "server error" if public else str(e)}, 500)
            return True

        def do_GET(self):
            if not public:
                return self.serve_get()
            if not busy.acquire(blocking=False):
                return self.send_json({"error": "busy, try again shortly"}, 503, {"Retry-After": "5"})
            try:
                if self.public_gate():
                    self.serve_get()
            finally:
                busy.release()

        def serve_get(self):
            if self.dispatch(GET_ROUTES if public else PRIVATE_ROUTES):
                return
            path = urlparse(self.path).path
            if path.startswith("/api/"):
                return self.send_json({"error": "not found"}, 404)
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            full = os.path.realpath(os.path.join(STATIC_DIR, rel))
            if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
                return self.send_json({"error": "not found"}, 404)
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", CONTENT_TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))
            self.send_header("Cache-Control", "max-age=86400" if "/vendor/" in full else "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def same_origin(self):
            """Blocks other websites from making your browser start things here (CSRF). Browsers label
            cross-site requests with Sec-Fetch-Site (or Origin); scripts and curl send neither."""
            site = self.headers.get("Sec-Fetch-Site")
            if site:
                return site in ("same-origin", "none")
            origin = self.headers.get("Origin")
            if not origin:
                return True
            hosts = {h.strip().lower() for h in (self.headers.get("Host"), self.headers.get("X-Forwarded-Host")) if h}
            return urlparse(origin).netloc.lower() in hosts

        def do_POST(self):
            if public:  # nothing can be started or changed from the public dashboard
                return self.send_json({"error": "this is a read-only public dashboard"}, 403)
            if not self.same_origin():
                log.warning("refused %s from another website (Origin %s)", self.path, self.headers.get("Origin"))
                return self.send_json({"error": "requests from other websites aren't allowed"}, 403)
            if not self.dispatch(POST_ROUTES):
                self.send_json({"error": "not found"}, 404)

    return Handler


# --------------------------------------------------------------------------- main

def is_netbae(host, port):
    """True if a netBae dashboard already answers on this port."""
    try:
        conn = http.client.HTTPConnection("127.0.0.1" if host in ("", "0.0.0.0", "::") else host, port, timeout=3)
        conn.request("GET", "/api/config")
        return "version" in json.loads(conn.getresponse().read())
    except Exception:
        return False


class DualStackServer(ThreadingHTTPServer):
    """host = "::": IPv6 and (where the OS allows) IPv4 on one socket."""
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (OSError, AttributeError):
            pass
        super().server_bind()


def http_server(host, port, handler):
    return (DualStackServer if ":" in str(host) else ThreadingHTTPServer)((host, port), handler)


def peer_ip(addr):
    """A client address as an ipaddress object (IPv4 clients of a dual-stack socket come as ::ffff:a.b.c.d)."""
    try:
        a = ipaddress.ip_address(str(addr).split("%")[0])
    except ValueError:
        return None
    return a.ipv4_mapped if a.version == 6 and a.ipv4_mapped else a


def bind_web(host, port, handler, tries=20):
    """The dashboard's server on the configured port, or the next free one if something else holds it."""
    # On Windows SO_REUSEADDR would let a second copy bind the same port instead of failing.
    ThreadingHTTPServer.allow_reuse_address = not IS_WINDOWS
    ThreadingHTTPServer.request_queue_size = 128  # default of 5 drops parallel dashboard requests
    for p in range(port, min(port + tries, 65536)):
        try:
            httpd = http_server(host, p, handler)
        except OSError as e:
            if is_netbae(host, p):
                sys.exit(f"netBae is already running on port {p}")
            log.warning("port %d is in use (%s)%s", p, e.strerror or e, ", trying the next one" if p + 1 < port + tries else "")
            continue
        if p != port:
            log.warning("serving on port %d instead of %d; set [web] port = %d in the config to keep it", p, port, p)
        httpd.daemon_threads = True
        return httpd
    sys.exit(f"no free port between {port} and {port + tries - 1}; set a different [web] port in the config")


def main():
    ap = argparse.ArgumentParser(description="netBae internet connection monitor")
    ap.add_argument("-c", "--config", default=os.environ.get("NETBAE_CONFIG", DEFAULT_CONFIG_PATH))
    ap.add_argument("--print-port", action="store_true", help="print the configured web port and exit")
    ap.add_argument("--check-config", action="store_true", help="validate and print the effective config")
    ap.add_argument("--log-file", help="log to this file (rotated at 1 MB, 5 kept) instead of stderr")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    handlers = None
    if args.log_file:  # Windows: a scheduled task has no journal to catch stderr
        handlers = [logging.handlers.RotatingFileHandler(args.log_file, maxBytes=1 << 20, backupCount=5,
                                                         encoding="utf-8")]
        sys.excepthook = lambda *exc: log.critical("netBae stopped", exc_info=exc)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    cfg = load_config(args.config)
    if args.print_port:
        print(cfg["web"]["port"])
        return
    if args.check_config:
        print(json.dumps(cfg, indent=2))
        st = cfg["speedtest"]
        if st["enabled"]:
            nxt = next_aligned(st["interval_minutes"] * 60, st["offset_minutes"] * 60)
            print("next speedtest:", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(nxt)))
            if st["regions"]:
                nxt = next_aligned(st["regions_interval_minutes"] * 60, st["regions_offset_minutes"] * 60)
                print("next region speedtests:", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(nxt)),
                      "-", ", ".join(r["name"] for r in st["regions"]))
        return

    monitor = Monitor(cfg)
    monitor.config_path = os.path.abspath(args.config)
    host, port = cfg["web"]["host"], int(cfg["web"]["port"])
    httpd = bind_web(host, port, make_handler(monitor))
    monitor.start()  # only once the port is ours, so a second copy never collects alongside the first
    log.info("netBae %s dashboard listening on http://%s:%d", VERSION, host, httpd.server_address[1])
    pub = cfg["public"]
    if pub["enabled"]:
        pport = int(pub["port"])
        try:
            if pport == httpd.server_address[1]:
                raise OSError("it's the same port as the main dashboard")
            pserver = http_server(pub["host"], pport, make_handler(monitor, public=True))
            pserver.daemon_threads = True
            threading.Thread(target=pserver.serve_forever, name="public-web", daemon=True).start()
            log.info("read-only public dashboard listening on http://%s:%d (%d requests/min per visitor)",
                     pub["host"], pport, int(pub["requests_per_minute"]))
        except OSError as e:
            log.error("couldn't start the public dashboard on port %d (%s); the main dashboard still runs", pport, e)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
