#!/usr/bin/env bash
# Runs the real Linux installer end to end inside throwaway systemd containers:
# install, check the service and API, re-install (update), uninstall, install again, uninstall --purge.
#   scripts/test-linux-install.sh                 # all distros below
#   scripts/test-linux-install.sh debian:bookworm  # just one
#   scripts/test-linux-install.sh unifi            # UniFi OS: Debian 11 made to look like a UniFi console
# Needs Docker. Containers run --privileged so systemd can boot; nothing touches the host's netBae.
set -euo pipefail
cd "$(dirname "$0")/.."
DISTROS=("$@")
[[ ${#DISTROS[@]} -gt 0 ]] || DISTROS=(debian:bookworm debian:trixie ubuntu:24.04 fedora:latest unifi)

image_for() {  # a systemd-booting image of the distro, with only what a fresh server has
  local base=$1 tag="netbae-systest:${1//[:\/]/-}" setup extra=""
  case "$base" in
    unifi)
      # UniFi OS 4/5 is Debian 11 with Python 3.9 (no tomli, no pip), busybox and nginx on ports 80 and 443.
      # The installer must make do with that and never use apt: apt-get is a stub that records its use.
      # Debian 11 is out of support and its mirrors are being emptied, so use the image's pinned snapshot
      base=debian:bullseye
      setup="sed -i -e 's/^deb /#deb /' -e 's/^# deb http:\/\/snapshot/deb http:\/\/snapshot/' /etc/apt/sources.list && apt-get -o Acquire::Check-Valid-Until=false update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv curl ca-certificates procps iproute2 iputils-ping busybox python3 >/dev/null && rm -rf /var/lib/apt/lists/*"
      extra=$(cat <<'UNIFI'
RUN printf '#!/bin/sh\necho "UniFi Cloud Gateway Ultra (test)"\n' >/usr/bin/ubnt-device-info && chmod 755 /usr/bin/ubnt-device-info \
 && mkdir -p /data /usr/share/ubios-udapi-server \
 && for b in apt apt-get; do printf '#!/bin/sh\necho "$0 $*" >>/tmp/apt-used; exit 1\n' >/usr/bin/$b; done \
 && printf '[Service]\nExecStart=/usr/bin/python3 -m http.server 80\n[Install]\nWantedBy=multi-user.target\n' >/etc/systemd/system/fake-nginx.service \
 && ln -s /etc/systemd/system/fake-nginx.service /etc/systemd/system/multi-user.target.wants/fake-nginx.service
UNIFI
)
      ;;
    debian*|ubuntu*) setup="apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv curl ca-certificates sudo procps >/dev/null && rm -rf /var/lib/apt/lists/*" ;;
    fedora*|rocky*|alma*) setup="dnf install -y -q systemd curl sudo procps-ng tar && dnf clean all" ;;
    archlinux*) setup="pacman -Sy --noconfirm --needed systemd curl sudo procps-ng" ;;
    *) echo "no setup for $base" >&2; return 1 ;;
  esac
  docker build -q -t "$tag" - >/dev/null <<EOF
FROM $base
RUN $setup
$extra
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
  echo "$tag"
}

linux_test() { cat <<'TEST'
set -euo pipefail
ok() { echo "  ok: $*"; }
fail() { echo "  FAIL: $*"; journalctl -u netbae --no-pager -n 40 || true; exit 1; }
port() { sed -n '/^\[web\]/,/^\[/s/^port = \([0-9]*\).*/\1/p' /etc/netbae/config.toml; }
api() { curl -fsS --max-time 5 "http://127.0.0.1:$(port)/api/$1"; }
wait_api() { for _ in $(seq 30); do api config >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
cd /root/netbae

bash install.sh > /tmp/install1.log 2>&1 || { tail -40 /tmp/install1.log; fail "install.sh exited non-zero"; }
grep -iE "warn|error|tarball|packagecloud|repository" /tmp/install1.log | sed 's/^/  log: /' || true
ok "install.sh finished"
systemctl is-active --quiet netbae || fail "service not active"
systemctl is-enabled --quiet netbae || fail "service not enabled"
ok "service active and enabled (port $(port))"
wait_api || fail "API not answering"
api config | python3 -c 'import json,sys; c=json.load(sys.stdin); print("  ok: API up, version", c.get("version"))'
id netbae >/dev/null || fail "no netbae user"
[[ $(stat -c %U /var/lib/netbae) == netbae ]] || fail "/var/lib/netbae not owned by netbae"
ok "service user and data folder"
command -v speedtest >/dev/null || fail "Ookla speedtest CLI missing"
speedtest --version | head -1 | grep -qi ookla || fail "speedtest is not the Ookla CLI"
ok "Ookla CLI: $(speedtest --version | head -1)"
if command -v rpm >/dev/null && rpm -q speedtest >/dev/null 2>&1; then
  rpm -qi speedtest | grep -qi ookla || fail "installed the distro's unrelated 'speedtest' package"
fi
[[ -s /opt/netbae/static/vendor/chart.umd.min.js ]] || fail "Chart.js not downloaded"
command -v netbae >/dev/null && netbae status >/dev/null 2>&1 || fail "netbae helper"
ok "helper command and vendored Chart.js"
n=0
for _ in $(seq 45); do  # up to 90s: pings run every 30s by default, and startup checks can delay the first ones
  sleep 2
  n=$(api ping | python3 -c 'import json,sys; s=json.load(sys.stdin)["series"]; print(sum(len(v) for v in (s.values() if isinstance(s,dict) else s)))' 2>/dev/null || echo 0)
  [[ $n -gt 0 ]] && break
done
[[ $n -gt 0 ]] || fail "no ping results after 90s"
ok "ping data collected ($n)"
api system | python3 -c 'import json,sys; s=json.load(sys.stdin); assert s.get("uptime") or s.get("cpu") is not None, s' || fail "system info"
ok "system info"

sed -i 's/^\(interval_seconds = \)[0-9]*$/\17/' /etc/netbae/config.toml
grep -q '^interval_seconds = 7$' /etc/netbae/config.toml || fail "couldn't change the config for the update test"
bash install.sh > /tmp/install2.log 2>&1 || { tail -40 /tmp/install2.log; fail "re-install (update) failed"; }
grep -q '^interval_seconds = 7$' /etc/netbae/config.toml || fail "update overwrote the config"
wait_api || fail "API not answering after update"
ok "update kept the config and restarted"

# the dashboard's Update button: the service asks, the root netbae-update unit runs `netbae update`
systemctl is-enabled --quiet netbae-update.path || fail "netbae-update.path isn't enabled"
api config | python3 -c 'import json,sys; u=json.load(sys.stdin)["update"]; assert u["method"] == "button", u' || fail "update method isn't button"
curl -fsS -X POST "http://127.0.0.1:$(port)/api/update/run" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["started"], r' \
  || fail "the Update button request was refused"
for _ in $(seq 80); do
  [[ ! -e /var/lib/netbae/update-request ]] && grep -Eq 'and running|nothing to update' /var/lib/netbae/update.log 2>/dev/null && break
  sleep 3
done
grep -Eq 'and running|nothing to update' /var/lib/netbae/update.log 2>/dev/null || { tail -20 /var/lib/netbae/update.log; fail "the Update button didn't update"; }
wait_api || fail "API not answering after the Update button"
grep -q '^interval_seconds = 7$' /etc/netbae/config.toml || fail "the Update button overwrote the config"
ok "the dashboard's Update button ran netbae update"

netbae tunnel cloudflare --token eyJhIjoiMCIsInQiOiIwIiwicyI6IjAifQ== > /tmp/tun.log 2>&1 || { cat /tmp/tun.log; fail "netbae tunnel failed"; }
[[ $(systemctl show netbae-tunnel -p User --value) == netbae ]] || fail "tunnel service doesn't run as netbae"
curl -fsS --max-time 5 http://127.0.0.1:8080/api/config | grep -q '"public":true' || fail "public dashboard not on"
[[ $(sed -n '/^\[public\]/,/^\[/s/^host = "\([^"]*\)".*/\1/p' /etc/netbae/config.toml) == 127.0.0.1 ]] || fail "public host not 127.0.0.1"
netbae tunnel status >/dev/null || fail "netbae tunnel status"
netbae tunnel off > /tmp/tun.log 2>&1 || { cat /tmp/tun.log; fail "netbae tunnel off"; }
[[ ! -e /etc/systemd/system/netbae-tunnel.service ]] || fail "tunnel service left after off"
! curl -fsS --max-time 2 http://127.0.0.1:8080/api/config >/dev/null 2>&1 || fail "public dashboard still on after off"
ok "netbae tunnel: service as netbae, public on 127.0.0.1, status, off"

bash uninstall.sh > /tmp/un1.log 2>&1 || fail "uninstall failed"
! systemctl is-active --quiet netbae || fail "service still running after uninstall"
[[ ! -e /opt/netbae && ! -e /etc/systemd/system/netbae.service && ! -e /etc/systemd/system/netbae-update.path ]] || fail "files left after uninstall"
[[ -f /etc/netbae/config.toml && -d /var/lib/netbae ]] || fail "uninstall removed config/data without --purge"
ok "uninstall kept config and data"

bash install.sh > /tmp/install3.log 2>&1 || { tail -40 /tmp/install3.log; fail "re-install after uninstall failed"; }
wait_api || fail "API not answering after re-install"
grep -q '^interval_seconds = 7$' /etc/netbae/config.toml || fail "re-install lost the config"
ok "re-install picked up the kept config"

bash uninstall.sh --purge > /tmp/un2.log 2>&1 || fail "uninstall --purge failed"
[[ ! -e /etc/netbae && ! -e /var/lib/netbae ]] || fail "purge left config/data"
! id netbae >/dev/null 2>&1 || fail "purge left the netbae user"
! pgrep -f /opt/netbae/netbae.py >/dev/null || fail "netbae process left running"
ok "uninstall --purge removed everything"
TEST
}

# UniFi OS: everything in /data/netbae and no apt; port 81 next to UniFi's web server; then a firmware update
# (units, user and /usr/local/bin gone) put right by /data/netbae/install.sh without losing the history.
unifi_test() { cat <<'TEST'
set -euo pipefail
D=/data/netbae
ok() { echo "  ok: $*"; }
fail() { echo "  FAIL: $*"; journalctl -u netbae --no-pager -n 40 || true; exit 1; }
port() { sed -n '/^\[web\]/,/^\[/s/^port = \([0-9]*\).*/\1/p' $D/config.toml; }
api() { curl -fsS --max-time 5 "http://127.0.0.1:$(port)/api/$1"; }
wait_api() { for _ in $(seq 30); do api config >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
rows() { python3 -c 'import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT COUNT(*) FROM ping").fetchone()[0])' $D/data/netbae.db; }
cd /root/netbae
for _ in $(seq 10); do ss -Hltn 'sport = :80' | grep -q . && break; sleep 1; done

bash install.sh > /tmp/install1.log 2>&1 || { tail -40 /tmp/install1.log; fail "install.sh exited non-zero"; }
grep -iE "warn|error" /tmp/install1.log | sed 's/^/  log: /' || true
ok "install.sh finished"
[[ ! -e /tmp/apt-used ]] || { cat /tmp/apt-used; fail "install.sh used apt on UniFi OS"; }
[[ ! -e /opt/netbae && ! -e /etc/netbae && ! -e /var/lib/netbae && ! -e /usr/local/bin/speedtest ]] || fail "files outside /data"
ok "no apt, nothing outside /data/netbae"
[[ $(port) == 81 ]] || fail "port $(port), expected 81 (UniFi's web server has 80)"
systemctl is-active --quiet netbae || fail "service not active"
systemctl is-enabled --quiet netbae || fail "service not enabled"
ok "service active and enabled on port 81"
unit=/etc/systemd/system/netbae.service
for line in "ExecStart=/usr/bin/python3 $D/app/netbae.py -c $D/config.toml" "Environment=PYTHONPATH=$D/lib" \
            "Environment=PATH=$D/bin:/usr/sbin:/usr/bin:/sbin:/bin" "Environment=HOME=$D/data" "ReadWritePaths=$D/data" "Nice=10"; do
  grep -qxF "$line" $unit || fail "$unit has no '$line'"
done
ok "unit runs from /data/netbae with the bundled tomli and tools"
[[ -f $D/lib/tomli/__init__.py ]] || fail "tomli not bundled"
[[ $(readlink $D/bin/traceroute) == /bin/busybox ]] || fail "no busybox traceroute link"
$D/bin/speedtest --version | head -1 | grep -qi ookla || fail "no Ookla CLI in $D/bin"
[[ $(readlink /usr/local/bin/netbae) == "$D/bin/netbae" ]] && netbae status >/dev/null 2>&1 || fail "netbae command"
[[ -s $D/app/static/vendor/chart.umd.min.js && -x $D/install.sh ]] || fail "Chart.js or $D/install.sh missing"
ok "tomli, traceroute, Ookla CLI $($D/bin/speedtest --version | head -1 | awk '{print $4}'), netbae command, Chart.js"
wait_api || fail "API not answering"
api config | python3 -c '
import json, sys
c = json.load(sys.stdin)
assert "gateway" not in [t["id"] for t in c["ping"]["targets"]], "Router ping target still there"
assert [s["host"] for s in c["dns"]["servers"] if s["id"] == "gateway"] == ["127.0.0.1"], c["dns"]["servers"][:2]
assert c["update"]["method"] == "button", c["update"]' || fail "API config"
grep -qF "$D/bin/netbae update" /etc/systemd/system/netbae-update.service || fail "update unit doesn't run $D/bin/netbae"
systemctl is-enabled --quiet netbae-update.path || fail "netbae-update.path isn't enabled"
ok "no Router ping target, router DNS on 127.0.0.1, Update button set up"
n=0
for _ in $(seq 45); do
  sleep 2
  n=$(api ping | python3 -c 'import json,sys; s=json.load(sys.stdin)["series"]; print(sum(len(v) for v in (s.values() if isinstance(s,dict) else s)))' 2>/dev/null || echo 0)
  [[ $n -gt 0 ]] && break
done
[[ $n -gt 0 ]] || fail "no ping results after 90s"
! journalctl -u netbae --no-pager | grep -q "could not detect the default gateway" || fail "gateway warning logged"
ok "ping data collected ($n), no gateway warning"

sed -i 's/^\(interval_seconds = \)[0-9]*$/\17/' $D/config.toml
bash install.sh > /tmp/install2.log 2>&1 || { tail -40 /tmp/install2.log; fail "re-install (update) failed"; }
grep -q '^interval_seconds = 7$' $D/config.toml || fail "update overwrote the config"
[[ ! -e /tmp/apt-used ]] || fail "update used apt"
wait_api || fail "API not answering after update"
ok "update kept the config and restarted"

# a firmware update: only /data survives
systemctl disable --now netbae netbae-update.path >/dev/null 2>&1  # stopping saves what's in memory
before=$(rows)
rm -f /etc/systemd/system/netbae* /usr/local/bin/netbae
userdel netbae
useradd --system other-service  # takes netbae's old uid, as a firmware update can
systemctl daemon-reload
bash $D/install.sh > /tmp/restore.log 2>&1 || { tail -40 /tmp/restore.log; fail "$D/install.sh (restore) failed"; }
grep -q "is back and running" /tmp/restore.log || { tail -20 /tmp/restore.log; fail "restore didn't say it's back"; }
systemctl is-active --quiet netbae && systemctl is-enabled --quiet netbae || fail "service not back"
systemctl is-enabled --quiet netbae-update.path || fail "Update button not back"
[[ $(stat -c %U $D/data/netbae.db) == netbae ]] || fail "history not owned by the new netbae user"
wait_api || fail "API not answering after restore"
[[ $(rows) -ge $before && $before -gt 0 ]] || fail "history lost ($before rows before, $(rows) after)"
grep -q '^interval_seconds = 7$' $D/config.toml || fail "restore changed the config"
netbae version | grep -q netBae || fail "netbae command not back"
ok "after a firmware update, $D/install.sh put it back with the history ($before ping rows)"

netbae uninstall > /tmp/un1.log 2>&1 || { cat /tmp/un1.log; fail "uninstall failed"; }
! systemctl is-active --quiet netbae || fail "service still running after uninstall"
[[ ! -e $D/app && ! -e $D/bin && ! -e /etc/systemd/system/netbae.service && ! -e /usr/local/bin/netbae ]] || fail "files left after uninstall"
[[ -f $D/config.toml && -f $D/data/netbae.db ]] || fail "uninstall removed config/data without --purge"
ok "uninstall kept config and data"
bash install.sh > /tmp/install3.log 2>&1 || { tail -40 /tmp/install3.log; fail "re-install after uninstall failed"; }
wait_api || fail "API not answering after re-install"
grep -q '^interval_seconds = 7$' $D/config.toml || fail "re-install lost the config"
ok "re-install picked up the kept config"
netbae uninstall --purge > /tmp/un2.log 2>&1 || fail "uninstall --purge failed"
[[ ! -e $D ]] || fail "purge left $D"
! id netbae >/dev/null 2>&1 || fail "purge left the netbae user"
[[ ! -e /tmp/apt-used ]] || fail "something used apt"
ok "uninstall --purge removed everything"
TEST
}

FAILED=()
for distro in "${DISTROS[@]}"; do
  echo "=== $distro"
  name="netbae-systest-$$-${distro//[:\/]/-}"
  img=$(image_for "$distro")
  docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock "$img" >/dev/null
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 30); do
    state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
    [[ $state == running || $state == degraded ]] && break; sleep 1
  done
  COPYFILE_DISABLE=1 tar --exclude=.git --exclude='*.db*' --exclude=netbae-data -cf - . | docker exec -i "$name" sh -c 'mkdir -p /root/netbae && tar --warning=no-unknown-keyword -xf - -C /root/netbae'
  if [[ $distro == unifi ]]; then test_body=unifi_test; else test_body=linux_test; fi
  if "$test_body" | docker exec -i "$name" bash -s
  then echo "=== $distro: PASS"; else echo "=== $distro: FAIL"; FAILED+=("$distro"); fi
  docker rm -f "$name" >/dev/null
done

[[ ${#FAILED[@]} -eq 0 ]] && echo "All passed: ${DISTROS[*]}" || { echo "Failed: ${FAILED[*]}"; exit 1; }
