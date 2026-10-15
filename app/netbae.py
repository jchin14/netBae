#!/usr/bin/env python3
"""netBae - lightweight internet connection monitor.

Collects ping latency, DNS response times, Ookla speedtests and system stats
into SQLite and serves a dashboard + JSON API. Python standard library only.
"""
import argparse
import copy
import ctypes
import ctypes.util
import ipaddress
import json
import logging
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
VERSION = "1.2.1"

DEFAULT_CONFIG = {
    "web": {"host": "0.0.0.0", "port": 80},
    # raw samples -> 1-minute summaries -> hourly summaries; 0 = keep forever
    "storage": {"database": "/var/lib/netbae/netbae.db", "raw_retention_days": 7, "minute_retention_days": 90,
                "retention_days": 0},
    "ping": {
        "interval_seconds": 5,
        "offset_seconds": 0,
        "timeout_seconds": 2,
        "targets": [
            {"name": "Router", "host": "gateway", "group": "Network"},
            {"name": "Cloudflare DNS", "host": "1.1.1.1", "group": "DNS"},
            {"name": "Google DNS", "host": "8.8.8.8", "group": "DNS"},
            {"name": "Quad9", "host": "9.9.9.9", "group": "DNS"},
            {"name": "Google", "host": "google.com", "group": "Google"},
            {"name": "YouTube", "host": "youtube.com", "group": "Google"},
            {"name": "Netflix", "host": "www.netflix.com", "group": "Streaming"},
            {"name": "Twitch", "host": "twitch.tv", "group": "Streaming"},
            {"name": "Steam & CS2", "host": "valve:auto", "group": "Gaming"},
            {"name": "Fortnite", "host": "epic:auto", "group": "Gaming"},
            {"name": "Discord voice", "host": "discord:auto", "group": "Gaming"},
            {"name": "Facebook", "host": "facebook.com", "group": "Social"},
            {"name": "Reddit", "host": "reddit.com", "group": "Social"},
            {"name": "Microsoft", "host": "microsoft.com", "group": "Cloud & tech"},
            {"name": "Apple", "host": "apple.com", "group": "Cloud & tech"},
            {"name": "AWS", "host": "aws.amazon.com", "group": "Cloud & tech"},
            {"name": "GitHub", "host": "github.com", "group": "Cloud & tech"},
            {"name": "Akamai", "host": "akamai.com", "group": "CDN"},
            {"name": "Fastly", "host": "fastly.com", "group": "CDN"},
        ],
        # Latency to the fastest Ookla speedtest server in each region (TCP connect), shown as a "Regions" group.
        "regions": ["Sydney", "Perth", "Auckland", "Singapore", "Hong Kong", "Tokyo", "Guam", "Delhi", "Oman",
                    "Los Angeles", "Toronto", "New York", "São Paulo", "London", "Amsterdam", "Paris", "Milan",
                    "Cape Town"],
        "region_interval_seconds": 30,
    },
    "dns": {
        "enabled": True,
        "interval_seconds": 30,
        "offset_seconds": 0,
        "timeout_seconds": 2,
        "servers": [
            {"name": "Router", "host": "gateway"},
            {"name": "Cloudflare", "host": "1.1.1.1"},
            {"name": "Google", "host": "8.8.8.8"},
            {"name": "Quad9", "host": "9.9.9.9"},
            {"name": "Cloudflare", "host": "2606:4700:4700::1111"},
            {"name": "Google", "host": "2001:4860:4860::8888"},
            {"name": "Quad9", "host": "2620:fe::fe"},
        ],
        "domains": ["google.com", "microsoft.com", "facebook.com", "reddit.com", "netflix.com"],
    },
    "speedtest": {
        "enabled": True,
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

def normalize_connection(c):
    """A secondary internet connection (e.g. a 5G/4G WAN) measured through its own source IP or interface."""
    if not isinstance(c, dict) or not c.get("name") or not c.get("bind"):
        raise SystemExit("[[connections]] entries need a name and a bind (source IP or interface name)")
    name, bind = str(c["name"]), str(c["bind"])
    try:
        ipaddress.ip_address(bind)
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", bind):
            raise SystemExit(f"connection {name}: bind must be an IP address or interface name")
    targets = []
    for t in c.get("targets") or ["1.1.1.1", "8.8.8.8", "google.com"]:
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


def find_speedtest(binary):
    """Resolve 'auto' to the Ookla CLI: /usr/bin (official package), /usr/local/bin (tarball)
    or Homebrew on macOS."""
    if binary and binary != "auto":
        return binary
    for cand in ("/usr/bin/speedtest", "/usr/local/bin/speedtest", "/opt/homebrew/bin/speedtest",
                 shutil.which("speedtest")):
        if cand and os.access(cand, os.X_OK):
            return cand
    return "speedtest"


def load_config(path):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if os.path.exists(path):
        if tomllib is None:
            raise SystemExit("Python 3.11+ (or the 'tomli' package) is required to read the config file")
        with open(path, "rb") as f:
            user = tomllib.load(f)
        for section, values in user.items():
            if isinstance(values, dict):
                cfg.setdefault(section, {}).update(values)
            elif section == "connections" and isinstance(values, list):
                cfg["connections"] = values
    else:
        log.warning("config %s not found, using built-in defaults", path)

    cfg["ping"]["targets"] = [normalize_target(t) for t in cfg["ping"]["targets"]]
    cfg["ping"]["regions"] = [r for r in map(normalize_region, cfg["ping"]["regions"]) if r]
    for r in cfg["ping"]["regions"]:
        cfg["ping"]["targets"].append({"id": f"region:{r['name']}", "name": r["name"], "host": None,
                                       "method": "region", "port": None, "group": "Regions", "region": r,
                                       "flag": r["flag"]})
    cfg["connections"] = [normalize_connection(c) for c in cfg["connections"]]
    for c in cfg["connections"]:
        cfg["ping"]["targets"].extend(c["targets"])
    cfg["dns"]["servers"] = [normalize_target(t) for t in cfg["dns"]["servers"]]
    for s in cfg["dns"]["servers"]:
        s["id"] = s["id"].replace("tcp://", "").rsplit(":", 1)[0] if s["method"] == "tcp" else s["id"]
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
CREATE INDEX IF NOT EXISTS system_ts ON system(ts);
CREATE TABLE IF NOT EXISTS ping_1m (
    target TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL, PRIMARY KEY (target, ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ping_1m_ts ON ping_1m(ts);
CREATE TABLE IF NOT EXISTS dns_1m (
    server TEXT NOT NULL, domain TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL, PRIMARY KEY (server, domain, ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS dns_1m_ts ON dns_1m(ts);
CREATE TABLE IF NOT EXISTS ping_1h (
    target TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL, PRIMARY KEY (target, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dns_1h (
    server TEXT NOT NULL, domain TEXT NOT NULL, ts INTEGER NOT NULL, n INTEGER, ok INTEGER,
    avg REAL, mn REAL, mx REAL, p5 REAL, p95 REAL, PRIMARY KEY (server, domain, ts)) WITHOUT ROWID;
"""

# Raw samples are summarised into 1-minute rows (count, avg, min, max, p5, p95) so long
# ranges stay fast and raw data can be dropped after raw_retention_days.
SERIES = {
    "ping": {"raw": "ping", "rollup": "ping_1m", "hourly": "ping_1h", "keys": ["target"], "val": "rtt"},
    "dns": {"raw": "dns", "rollup": "dns_1m", "hourly": "dns_1h", "keys": ["server", "domain"], "val": "ms"},
}
ROLLUP_ABOVE_SECONDS = 6 * 3600  # whole-range stats longer than this come from the 1-minute table


def pct_select(val, bucket_expr, keys, table, where):
    """Per-bucket count/ok/avg/min/max/p5/p95 from raw samples (nearest-rank percentiles)."""
    part = ", ".join(keys + [bucket_expr])
    return (
        f"SELECT {', '.join(keys)}, b, COUNT(*), COUNT(v), AVG(v), MIN(v), MAX(v),"
        f" MIN(CASE WHEN rn >= 0.05 * cnt THEN v END), MIN(CASE WHEN rn >= 0.95 * cnt THEN v END)"
        f" FROM (SELECT {', '.join(keys)}, {bucket_expr} AS b, {val} AS v,"
        f"   ROW_NUMBER() OVER (PARTITION BY {part} ORDER BY {val} IS NULL, {val}) AS rn,"
        f"   COUNT({val}) OVER (PARTITION BY {part}) AS cnt"
        f"   FROM {table} WHERE {where})"
        f" GROUP BY {', '.join(keys)}, b")


COMBINE = ("SUM(n), SUM(ok), SUM(avg * ok) / NULLIF(SUM(ok), 0), MIN(mn), MAX(mx),"
           " SUM(p5 * ok) / NULLIF(SUM(ok), 0), SUM(p95 * ok) / NULLIF(SUM(ok), 0)")


def rollup_hourly(db, spec, frm, to):
    keys = ", ".join(spec["keys"])
    db.conn().execute(
        f"INSERT OR REPLACE INTO {spec['hourly']} ({keys}, ts, n, ok, avg, mn, mx, p5, p95)"
        f" SELECT {keys}, CAST(ts / 3600 AS INTEGER) * 3600 AS h, {COMBINE}"
        f" FROM {spec['rollup']} WHERE ts >= ? AND ts < ? GROUP BY {keys}, h", (frm, to))


def rollup(db, spec, frm, to):
    keys = spec["keys"]
    sql = pct_select(spec["val"], "CAST(ts / 60 AS INTEGER) * 60", keys, spec["raw"], "ts >= ? AND ts < ?")
    db.conn().execute(
        f"INSERT OR REPLACE INTO {spec['rollup']} ({', '.join(keys)}, ts, n, ok, avg, mn, mx, p5, p95) {sql}",
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
        for col, typ in (("kind", "TEXT"), ("label", "TEXT"), ("data_bytes", "INTEGER")):  # added in 1.1/1.2
            if col not in cols:
                self.conn().execute(f"ALTER TABLE speedtest ADD COLUMN {col} {typ}")

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


def is_ip(v):
    try:
        ipaddress.ip_address(v)
        return True
    except ValueError:
        return False


def bind_socket(s, bind):
    """Send from a specific source IP, or out of a specific interface (Linux)."""
    if not bind:
        return
    if is_ip(bind):
        s.bind((bind, 0))
    else:
        s.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_BINDTODEVICE", 25), bind.encode())


def icmp_ping(host, timeout, bind=None):
    t = str(max(1, math.ceil(timeout)))
    if sys.platform == "darwin":
        cmd = ["ping", "-n", "-c", "1", "-t", t] + ((["-S", bind] if is_ip(bind) else ["-b", bind]) if bind else [])
    else:
        cmd = ["ping", "-n", "-c", "1", "-W", t] + (["-I", bind] if bind else [])
    cmd.append(host)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None
    m = PING_RE.search(out)
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
        p = subprocess.run(args, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout.strip() if p.returncode == 0 else None


def sysctl(name):
    return run_cmd(["/usr/sbin/sysctl", "-n", name])


IS_MAC = sys.platform == "darwin"


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


class SystemStats:
    def __init__(self, disk_path):
        self.disk_path = disk_path
        self.prev_cpu = None
        self.latest = {}
        self.mac_cpu = None
        if IS_MAC:
            try:
                self.mac_cpu = MacCPU()
            except (OSError, AttributeError):
                log.warning("could not read CPU usage via host_statistics()")

    def cpu_ticks(self):
        """(idle, total) cumulative CPU ticks."""
        if self.mac_cpu:
            return self.mac_cpu.ticks()
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

    @staticmethod
    def meminfo():
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
        except OSError:
            return None

    @staticmethod
    def uptime():
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

    @staticmethod
    def static_info():
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
        self.sys = SystemStats(cfg["system"]["disk_path"])
        self.static_info = self.sys.static_info()
        self.pool = ThreadPoolExecutor(max_workers=32, thread_name_prefix="probe")
        self.st_lock = threading.Lock()
        self.st_status = {"running": False}
        self.region_cache = {}
        self.region_lookups = set()
        self.game_cache = {}
        self.ipv6 = (0, None)  # (checked_at, available)
        self.started = time.time()

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
    def ping_one(self, t):
        timeout = self.cfg["ping"]["timeout_seconds"]
        bind = t.get("bind")
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
                            (("ping_1h", "dns_1h", "system", "speedtest"), cutoff)):
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
                             "download_mbps", "upload_mbps", "packet_loss", "result_url", "data_bytes"])
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
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=st["timeout_seconds"])
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
                    data_bytes=(result["download"].get("bytes") or 0) + (result["upload"].get("bytes") or 0),
                )
            else:
                row["error"] = err or p.stderr.strip()[-500:] or f"speedtest exited with code {p.returncode}"
        except FileNotFoundError:
            row["error"] = f"speedtest binary not found at {st['binary']}"
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


def parse_range(q, base_interval):
    now = time.time()
    to = float(q.get("to") or now)
    frm = float(q.get("from") or to - 3600)
    if frm >= to:
        raise ValueError("'from' must be before 'to'")
    points = max(20, min(2000, int(q.get("points") or 500)))
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
    if level != "raw":
        # Combine summary rows: exact count/min/max, sample-weighted avg and percentiles.
        sql = f"SELECT {key}, {bexpr} AS b, {COMBINE} FROM {spec[level]} WHERE {where} GROUP BY {key}, b ORDER BY b"
    else:
        sql = pct_select(spec["val"], bexpr, [key], spec["raw"], where) + " ORDER BY b"
    return m.db.query(sql, params)


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
        "info": m.static_info,
        "ping": {"interval_seconds": c["ping"]["interval_seconds"], "offset_seconds": c["ping"]["offset_seconds"],
                 "region_interval_seconds": c["ping"]["region_interval_seconds"],
                 "targets": [{k: v for k, v in t.items() if k != "region"} for t in c["ping"]["targets"]]},
        "dns": {"enabled": c["dns"]["enabled"], "interval_seconds": c["dns"]["interval_seconds"],
                "servers": c["dns"]["servers"], "domains": c["dns"]["domains"],
                "ipv6_available": m.ipv6_available()},
        "connections": [{"name": x["name"], "bind": x["bind"], "speedtest": x["speedtest"],
                         "speedtest_interval_minutes": x["speedtest_interval_minutes"]} for x in c["connections"]],
        "speedtest": {"enabled": c["speedtest"]["enabled"], "interval_minutes": c["speedtest"]["interval_minutes"],
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
    to = float(q.get("to") or now)
    frm = float(q.get("from") or to - 7 * 86400)
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


def api_summary(m, q):
    now = time.time()
    last = {t: (rtt, ts) for t, rtt, ts in m.db.query(
        "SELECT target, rtt, MAX(ts) FROM ping WHERE ts > ? GROUP BY target", (now - 120,))}
    agg = {t: (avg, n, ok) for t, avg, n, ok in m.db.query(
        "SELECT target, AVG(rtt), COUNT(*), COUNT(rtt) FROM ping WHERE ts > ? GROUP BY target", (now - 300,))}
    ping = []
    for t in m.cfg["ping"]["targets"]:
        l = last.get(t["id"], (None, None))
        a = agg.get(t["id"])
        ping.append({"id": t["id"], "name": t["name"], "host": t.get("display") or t["host"], "method": t["method"],
                     "group": t["group"], "flag": t.get("flag", ""), "connection": t.get("connection"),
                     "where": t.get("where") or ("finding nearest server…" if t["method"] == "game" else None),
                     "last": r2(l[0]), "last_ts": l[1],
                     "avg5m": r2(a[0]) if a else None,
                     "loss5m": round(100.0 * (a[1] - a[2]) / a[1], 1) if a else None})
    dns = {s: {"avg5m": r2(avg), "fail5m": round(100.0 * (n - ok) / n, 1)} for s, avg, n, ok in m.db.query(
        "SELECT server, AVG(ms), COUNT(*), COUNT(ms) FROM dns WHERE ts > ? GROUP BY server", (now - 300,))}
    main = "COALESCE(kind, 'main') = 'main'"
    ok = m.db.query(f"SELECT {','.join(ST_COLS)} FROM speedtest WHERE {main} AND error IS NULL ORDER BY ts DESC LIMIT 1")
    latest = m.db.query(f"SELECT {','.join(ST_COLS)} FROM speedtest WHERE {main} ORDER BY ts DESC LIMIT 1")
    averages = {label: st_avg(m, main, (), now - span) for label, span in (("24h", 86400), ("7d", 7 * 86400))}
    regions = st_by_label(m, "region", now)
    conns = st_by_label(m, "connection", now)
    flags = {r["name"]: r.get("flag", "") for r in m.cfg["speedtest"]["regions"]}
    return {
        "now": now, "ping": ping, "dns": dns,
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
    n, dl, ul, pg, jt, pl = m.db.query(
        "SELECT COUNT(*), AVG(download_mbps), AVG(upload_mbps), AVG(ping_ms), AVG(jitter_ms), AVG(packet_loss)"
        f" FROM speedtest WHERE {where} AND error IS NULL AND ts > ?", (*params, since))[0]
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


def api_run_speedtest(m, q):
    if not m.cfg["speedtest"]["enabled"]:
        return {"started": False, "reason": "speedtest is disabled in config"}
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


GET_ROUTES = {
    "/api/config": api_config, "/api/ping": api_ping, "/api/dns": api_dns,
    "/api/speedtest": api_speedtest, "/api/system": api_system,
    "/api/system/history": api_system_history, "/api/summary": api_summary,
}
POST_ROUTES = {"/api/speedtest/run": api_run_speedtest}
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                 ".json": "application/json", ".ico": "image/x-icon"}


def make_handler(monitor):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"netbae/{VERSION}"

        def log_message(self, fmt, *args):
            log.debug("%s - %s", self.address_string(), fmt % args)

        def send_json(self, obj, status=200):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
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
                self.send_json(fn(monitor, q))
            except ValueError as e:
                self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log.exception("API error on %s", self.path)
                self.send_json({"error": str(e)}, 500)
            return True

        def do_GET(self):
            if self.dispatch(GET_ROUTES):
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

        def do_POST(self):
            if not self.dispatch(POST_ROUTES):
                self.send_json({"error": "not found"}, 404)

    return Handler


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="netBae internet connection monitor")
    ap.add_argument("-c", "--config", default=os.environ.get("NETBAE_CONFIG", "/etc/netbae/config.toml"))
    ap.add_argument("--print-port", action="store_true", help="print the configured web port and exit")
    ap.add_argument("--check-config", action="store_true", help="validate and print the effective config")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
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
    monitor.start()
    host, port = cfg["web"]["host"], int(cfg["web"]["port"])
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer.request_queue_size = 128  # default of 5 drops parallel dashboard requests
    httpd = ThreadingHTTPServer((host, port), make_handler(monitor))
    httpd.daemon_threads = True
    log.info("netBae %s dashboard listening on http://%s:%d", VERSION, host, port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
