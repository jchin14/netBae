#!/usr/bin/env python3
"""netBae - lightweight internet connection monitor.

Collects ping latency, DNS response times, Ookla speedtests and system stats
into SQLite and serves a dashboard + JSON API. Python standard library only.
"""
import argparse
import copy
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
from concurrent.futures import ThreadPoolExecutor
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
VERSION = "1.0.0"

DEFAULT_CONFIG = {
    "web": {"host": "0.0.0.0", "port": 80},
    "storage": {"database": "/var/lib/netbae/netbae.db", "retention_days": 30},
    "ping": {
        "interval_seconds": 5,
        "offset_seconds": 0,
        "timeout_seconds": 2,
        "targets": [
            {"name": "Router", "host": "gateway"},
            {"name": "Cloudflare", "host": "1.1.1.1"},
            {"name": "Google DNS", "host": "8.8.8.8"},
            {"name": "Quad9", "host": "9.9.9.9"},
            {"name": "Microsoft", "host": "microsoft.com"},
            {"name": "Facebook", "host": "facebook.com"},
        ],
    },
    "dns": {
        "enabled": True,
        "interval_seconds": 30,
        "offset_seconds": 0,
        "timeout_seconds": 2,
        "servers": [
            {"name": "Router", "host": "gateway"},
            {"name": "Cloudflare", "host": "1.1.1.1"},
            {"name": "Google DNS", "host": "8.8.8.8"},
            {"name": "Quad9", "host": "9.9.9.9"},
        ],
        "domains": ["google.com", "microsoft.com", "facebook.com"],
    },
    "speedtest": {
        "enabled": True,
        "interval_minutes": 60,
        "offset_minutes": 0,
        "servers": [],
        "binary": "auto",
        "timeout_seconds": 300,
    },
    "system": {"interval_seconds": 30, "offset_seconds": 0, "disk_path": "/"},
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
    try:  # macOS / BSD, for local development
        out = subprocess.run(["route", "-n", "get", "default"], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r"gateway:\s*(\S+)", out)
        return m.group(1) if m else None
    except OSError:
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
    return {"id": tid, "name": name, "host": host, "method": method, "port": port}


def find_speedtest(binary):
    """Resolve 'auto' to the Ookla CLI: /usr/bin (official package) or /usr/local/bin (tarball)."""
    if binary and binary != "auto":
        return binary
    for cand in ("/usr/bin/speedtest", "/usr/local/bin/speedtest", shutil.which("speedtest")):
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
    else:
        log.warning("config %s not found, using built-in defaults", path)

    cfg["ping"]["targets"] = [normalize_target(t) for t in cfg["ping"]["targets"]]
    cfg["dns"]["servers"] = [normalize_target(t) for t in cfg["dns"]["servers"]]
    for s in cfg["dns"]["servers"]:
        s["id"] = s["id"].replace("tcp://", "").rsplit(":", 1)[0] if s["method"] == "tcp" else s["id"]
    cfg["speedtest"]["binary"] = find_speedtest(cfg["speedtest"]["binary"])
    cfg["speedtest"]["servers"] = [int(s) for s in cfg["speedtest"]["servers"]]

    ids = [t["id"] for t in cfg["ping"]["targets"]]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate ping targets in config")
    for sec, key in (("ping", "interval_seconds"), ("dns", "interval_seconds"),
                     ("system", "interval_seconds"), ("speedtest", "interval_minutes")):
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
"""


class DB:
    def __init__(self, path):
        self.path = path
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        self.local = threading.local()
        self.conn().executescript(SCHEMA)

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

PING_RE = re.compile(r"time[=<]\s*([\d.]+)\s*ms")


def icmp_ping(host, timeout):
    t = str(max(1, math.ceil(timeout)))
    if sys.platform == "darwin":
        cmd = ["ping", "-n", "-c", "1", "-t", t, host]
    else:
        cmd = ["ping", "-n", "-c", "1", "-W", t, host]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None
    m = PING_RE.search(out)
    return float(m.group(1)) if m else None


def tcp_ping(host, port, timeout):
    try:
        family, stype, proto, _, addr = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)[0]
    except OSError:
        return None
    s = socket.socket(family, stype, proto)
    s.settimeout(timeout)
    try:
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


class SystemStats:
    def __init__(self, disk_path):
        self.disk_path = disk_path
        self.prev_cpu = None
        self.latest = {}

    def cpu_percent(self):
        line = read_file("/proc/stat")
        if not line:
            return None
        vals = [int(v) for v in line.splitlines()[0].split()[1:9]]
        idle = vals[3] + vals[4]
        total = sum(vals)
        prev, self.prev_cpu = self.prev_cpu, (idle, total)
        if not prev or total == prev[1]:
            return None
        return round(100.0 * (1 - (idle - prev[0]) / (total - prev[1])), 1)

    @staticmethod
    def meminfo():
        raw = read_file("/proc/meminfo")
        if not raw:
            return None
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
        return float(raw.split()[0]) if raw else None

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
        return {
            "hostname": socket.gethostname(),
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
        self.started = time.time()

    def start(self):
        c = self.cfg
        self.sys.cpu_percent()  # prime the CPU delta
        run_aligned("ping", c["ping"]["interval_seconds"], c["ping"]["offset_seconds"], self.collect_ping)
        if c["dns"]["enabled"] and c["dns"]["servers"] and c["dns"]["domains"]:
            run_aligned("dns", c["dns"]["interval_seconds"], c["dns"]["offset_seconds"], self.collect_dns)
        run_aligned("system", c["system"]["interval_seconds"], c["system"]["offset_seconds"], self.collect_system)
        if c["speedtest"]["enabled"]:
            run_aligned("speedtest", c["speedtest"]["interval_minutes"] * 60,
                        c["speedtest"]["offset_minutes"] * 60, self.run_speedtest)
        run_aligned("cleanup", 3600, 1800, self.cleanup)
        self.pool.submit(self.collect_system)

    # -- collectors
    def ping_one(self, t):
        timeout = self.cfg["ping"]["timeout_seconds"]
        if t["method"] == "tcp":
            return tcp_ping(t["host"], t["port"], timeout)
        return icmp_ping(t["host"], timeout)

    def collect_ping(self):
        ts = time.time()
        targets = self.cfg["ping"]["targets"]
        results = list(self.pool.map(self.ping_one, targets))
        self.db.insert_many("INSERT INTO ping VALUES (?,?,?)",
                            [(ts, t["id"], r) for t, r in zip(targets, results)])

    def collect_dns(self):
        ts = time.time()
        timeout = self.cfg["dns"]["timeout_seconds"]
        jobs = [(s, d) for s in self.cfg["dns"]["servers"] for d in self.cfg["dns"]["domains"]]
        results = list(self.pool.map(lambda j: dns_query(j[0]["host"], j[1], timeout), jobs))
        self.db.insert_many("INSERT INTO dns VALUES (?,?,?,?)",
                            [(ts, s["id"], d, r) for (s, d), r in zip(jobs, results)])

    def collect_system(self):
        s = self.sys.sample()
        self.db.insert_many("INSERT INTO system VALUES (?,?,?,?,?,?)", [(
            s["ts"], s["cpu"],
            s["mem"]["percent"] if s["mem"] else None,
            s["disk"]["percent"] if s["disk"] else None,
            s["temp"],
            s["load"][0] if s["load"] else None,
        )])

    def cleanup(self):
        cutoff = time.time() - float(self.cfg["storage"]["retention_days"]) * 86400
        for table in ("ping", "dns", "system", "speedtest"):
            self.db.conn().execute(f"DELETE FROM {table} WHERE ts < ?", (cutoff,))
        self.db.conn().execute("PRAGMA wal_checkpoint(TRUNCATE)")

    # -- speedtest
    def run_speedtest(self, blocking=True):
        if not self.st_lock.acquire(blocking=blocking):
            return False
        try:
            for sid in (self.cfg["speedtest"]["servers"] or [None]):
                self._speedtest_once(sid)
        finally:
            self.st_status = {"running": False}
            self.st_lock.release()
        return True

    def _speedtest_once(self, server_id):
        st = self.cfg["speedtest"]
        self.st_status = {"running": True, "server_id": server_id, "started": time.time()}
        cmd = [st["binary"], "--format=json", "--accept-license", "--accept-gdpr"]
        if server_id:
            cmd += ["--server-id", str(server_id)]
        ts = time.time()
        row = {"server_id": server_id, "server_name": None, "server_location": None, "isp": None,
               "ping_ms": None, "jitter_ms": None, "download_mbps": None, "upload_mbps": None,
               "packet_loss": None, "result_url": None, "error": None}
        log.info("running speedtest (server=%s)", server_id or "auto")
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
                )
            else:
                row["error"] = err or p.stderr.strip()[-500:] or f"speedtest exited with code {p.returncode}"
        except FileNotFoundError:
            row["error"] = f"speedtest binary not found at {st['binary']}"
        except subprocess.TimeoutExpired:
            row["error"] = "speedtest timed out"
        if row["error"]:
            log.warning("speedtest failed: %s", row["error"])
        cols = ["ts"] + list(row)
        self.db.insert_many(f"INSERT INTO speedtest ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                            [[ts] + list(row.values())])

    # -- api helpers
    def target_name(self, tid):
        for t in self.cfg["ping"]["targets"]:
            if t["id"] == tid:
                return t["name"]
        return tid


# --------------------------------------------------------------------------- API

NICE_BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]


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


def bucketed(db, table, key_col, val_col, frm, to, bucket, keys=None, extra=("", ())):
    where, params = "ts >= ? AND ts <= ?", [frm, to]
    if keys:
        where += f" AND {key_col} IN ({','.join('?' * len(keys))})"
        params += keys
    if extra[0]:
        where += " AND " + extra[0]
        params += list(extra[1])
    rows = db.query(
        f"SELECT {key_col}, CAST(ts / ? AS INTEGER) AS b, AVG({val_col}), MIN({val_col}), MAX({val_col}),"
        f" COUNT(*), COUNT({val_col}) FROM {table} WHERE {where} GROUP BY {key_col}, b ORDER BY b",
        [bucket] + params)
    series = {}
    for key, b, avg, mn, mx, n, ok in rows:
        series.setdefault(key, []).append(
            [int(b * bucket * 1000), r2(avg), r2(mn), r2(mx), round(100.0 * (n - ok) / n, 2)])
    stats_rows = db.query(
        f"SELECT {key_col}, AVG({val_col}), MIN({val_col}), MAX({val_col}), COUNT(*), COUNT({val_col})"
        f" FROM {table} WHERE {where} GROUP BY {key_col}", params)
    stats = {k: {"avg": r2(a), "min": r2(mn), "max": r2(mx), "samples": n,
                 "loss": round(100.0 * (n - ok) / n, 2)} for k, a, mn, mx, n, ok in stats_rows}
    return series, stats


def r2(v):
    return None if v is None else round(v, 2)


def api_config(m, q):
    c = m.cfg
    return {
        "version": VERSION,
        "info": m.static_info,
        "ping": {"interval_seconds": c["ping"]["interval_seconds"], "offset_seconds": c["ping"]["offset_seconds"],
                 "targets": c["ping"]["targets"]},
        "dns": {"enabled": c["dns"]["enabled"], "interval_seconds": c["dns"]["interval_seconds"],
                "servers": c["dns"]["servers"], "domains": c["dns"]["domains"]},
        "speedtest": {"enabled": c["speedtest"]["enabled"], "interval_minutes": c["speedtest"]["interval_minutes"],
                      "offset_minutes": c["speedtest"]["offset_minutes"], "servers": c["speedtest"]["servers"],
                      "next_run": next_aligned(c["speedtest"]["interval_minutes"] * 60,
                                               c["speedtest"]["offset_minutes"] * 60)
                      if c["speedtest"]["enabled"] else None},
        "system": {"interval_seconds": c["system"]["interval_seconds"]},
        "retention_days": c["storage"]["retention_days"],
    }


def api_ping(m, q):
    frm, to, bucket = parse_range(q, m.cfg["ping"]["interval_seconds"])
    series, stats = bucketed(m.db, "ping", "target", "rtt", frm, to, bucket, split_list(q.get("targets")))
    return {"from": frm, "to": to, "bucket": bucket, "series": series, "stats": stats}


def api_dns(m, q):
    frm, to, bucket = parse_range(q, m.cfg["dns"]["interval_seconds"])
    domain = q.get("domain")
    extra = ("domain = ?", (domain,)) if domain else ("", ())
    series, stats = bucketed(m.db, "dns", "server", "ms", frm, to, bucket, split_list(q.get("servers")), extra)
    return {"from": frm, "to": to, "bucket": bucket, "series": series, "stats": stats}


def api_speedtest(m, q):
    now = time.time()
    to = float(q.get("to") or now)
    frm = float(q.get("from") or to - 7 * 86400)
    cols = ["ts", "server_id", "server_name", "server_location", "isp", "ping_ms", "jitter_ms",
            "download_mbps", "upload_mbps", "packet_loss", "result_url", "error"]
    rows = m.db.query(f"SELECT {','.join(cols)} FROM speedtest WHERE ts >= ? AND ts <= ? ORDER BY ts", (frm, to))
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
        ping.append({"id": t["id"], "name": t["name"], "host": t["host"], "method": t["method"],
                     "last": r2(l[0]), "last_ts": l[1],
                     "avg5m": r2(a[0]) if a else None,
                     "loss5m": round(100.0 * (a[1] - a[2]) / a[1], 1) if a else None})
    dns = {s: {"avg5m": r2(avg), "fail5m": round(100.0 * (n - ok) / n, 1)} for s, avg, n, ok in m.db.query(
        "SELECT server, AVG(ms), COUNT(*), COUNT(ms) FROM dns WHERE ts > ? GROUP BY server", (now - 300,))}
    cols = ["ts", "server_name", "server_location", "isp", "ping_ms", "jitter_ms",
            "download_mbps", "upload_mbps", "packet_loss", "result_url", "error"]
    ok = m.db.query(f"SELECT {','.join(cols)} FROM speedtest WHERE error IS NULL ORDER BY ts DESC LIMIT 1")
    latest = m.db.query(f"SELECT {','.join(cols)} FROM speedtest ORDER BY ts DESC LIMIT 1")
    return {
        "now": now, "ping": ping, "dns": dns,
        "speedtest": {
            "last_ok": dict(zip(cols, ok[0])) if ok else None,
            "latest": dict(zip(cols, latest[0])) if latest else None,
            "status": m.st_status,
        },
    }


def api_run_speedtest(m, q):
    if not m.cfg["speedtest"]["enabled"]:
        return {"started": False, "reason": "speedtest is disabled in config"}
    if m.st_lock.locked():
        return {"started": False, "reason": "a speedtest is already running"}
    threading.Thread(target=m.run_speedtest, kwargs={"blocking": False}, daemon=True).start()
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
