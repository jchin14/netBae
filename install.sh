#!/usr/bin/env bash
# netBae installer - works on any systemd-based Linux (Raspberry Pi OS, Debian,
# Ubuntu, Fedora/RHEL/Rocky/Alma, Arch, openSUSE) on x86_64, arm64, armhf/armv6, i386,
# and on macOS 12+ (Apple silicon or Intel) as a launchd daemon.
# Re-running upgrades in place and keeps your config + data.
#
#   From a checkout:   sudo bash install.sh
#   From GitHub:       curl -fsSL https://raw.githubusercontent.com/jchin14/netBae/main/install.sh | sudo bash
set -euo pipefail

NETBAE_REPO="${NETBAE_REPO:-jchin14/netBae}"   # GitHub owner/repo used for curl | bash installs
NETBAE_REF="${NETBAE_REF:-main}"                            # branch or tag to install
OS=$(uname -s)
if [[ $OS == Darwin ]]; then
  APP_DIR=/usr/local/lib/netbae
  CONF_DIR=/usr/local/etc/netbae
  DATA_DIR=/usr/local/var/netbae
  LOG_FILE=/usr/local/var/log/netbae.log
  SVC_USER=_netbae
  LABEL=com.github.netbae
  PLIST=/Library/LaunchDaemons/$LABEL.plist
else
  APP_DIR=/opt/netbae
  CONF_DIR=/etc/netbae
  DATA_DIR=/var/lib/netbae
  SVC_USER=netbae
fi
SPEEDTEST_VERSION=1.2.0
OOKLA_REPO=https://packagecloud.io/ookla/speedtest-cli
CHARTJS_URL=https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
ADAPTER_URL=https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

SCRIPT="${BASH_SOURCE[0]:-}"
if [[ $EUID -ne 0 ]]; then
  [[ -n "$SCRIPT" && -f "$SCRIPT" ]] && exec sudo NETBAE_REPO="$NETBAE_REPO" NETBAE_REF="$NETBAE_REF" bash "$SCRIPT" "$@"
  die "please run as root, e.g.: curl -fsSL <url>/install.sh | sudo bash"
fi
if [[ $OS == Linux ]]; then
  command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die "systemd is required"
elif [[ $OS != Darwin ]]; then
  die "unsupported OS '$OS' - netBae installs on systemd Linux and macOS"
fi

# ---------------------------------------------------------------- macOS prerequisites
# Homebrew refuses to run as root, so brew commands run as the user who owns the Homebrew prefix.
BREW=""; BREW_USER=""
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [[ $OS == Darwin && -x $b ]]; then BREW=$b; BREW_USER=$(stat -f %Su "$b"); break; fi
done
brew_run() { (cd /tmp && sudo -u "$BREW_USER" -H env HOMEBREW_NO_ENV_HINTS=1 "$BREW" "$@"); }

# Python 3.11+ (for tomllib): Homebrew, python.org or a recent Xcode Command Line Tools.
mac_python() {
  local c
  for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 \
           /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /usr/bin/python3; do
    # /usr/bin/python3 is only a stub (it pops up an install dialog) until the Command Line Tools exist
    [[ $c == /usr/bin/python3 ]] && ! xcode-select -p >/dev/null 2>&1 && continue
    if [[ -x $c ]] && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------- packages
if [[ $OS == Linux ]]; then c_info "Installing system packages"; fi
if [[ $OS == Darwin ]]; then
  [[ $BREW_USER != root ]] || die "Homebrew at $BREW is owned by root; brew cannot run as root"
  if ! PY=$(mac_python); then
    [[ -n $BREW ]] || die "netBae needs Python 3.11+. Install Homebrew (https://brew.sh) and re-run, or install Python from https://www.python.org/downloads/macos/"
    c_info "Installing Python 3 with Homebrew"
    brew_run install python || die "brew install python failed"
    PY=$(mac_python) || die "Python 3.11+ still not found after brew install python"
  fi
  c_info "Using $PY ($("$PY" --version))"
  PM=brew
elif command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 iputils-ping iproute2 traceroute curl ca-certificates tar gnupg >/dev/null
  PM=apt
elif command -v dnf >/dev/null; then
  dnf install -y -q python3 iputils iproute traceroute curl ca-certificates tar shadow-utils util-linux; PM=dnf
elif command -v yum >/dev/null; then
  yum install -y -q python3 iputils iproute traceroute curl ca-certificates tar shadow-utils util-linux; PM=yum
elif command -v pacman >/dev/null; then
  pacman -Sy --noconfirm --needed python iputils iproute2 traceroute curl ca-certificates tar; PM=pacman
elif command -v zypper >/dev/null; then
  zypper -n -q install python3 iputils iproute2 traceroute curl ca-certificates tar; PM=zypper
else
  die "unsupported package manager - install python3 (3.8+), ping and curl manually, then re-run"
fi

[[ -n ${PY:-} ]] || PY=$(command -v python3) || die "python3 not found"
if ! "$PY" -c 'import tomllib' 2>/dev/null && ! "$PY" -c 'import tomli' 2>/dev/null; then
  c_info "Python < 3.11 detected, installing tomli"
  case $PM in
    apt) apt-get install -y -qq python3-tomli >/dev/null 2>&1 || apt-get install -y -qq python3-pip >/dev/null ;;
    dnf|yum) $PM install -y -q python3-tomli 2>/dev/null || $PM install -y -q python3-pip ;;
    zypper) zypper -n -q install python3-tomli 2>/dev/null || zypper -n -q install python3-pip ;;
  esac
  "$PY" -c 'import tomli' 2>/dev/null || "$PY" -m pip install --quiet tomli 2>/dev/null \
    || "$PY" -m pip install --quiet --break-system-packages tomli \
    || die "could not install tomli; please install Python 3.11+ or the tomli package"
fi

# ---------------------------------------------------------------- source files
# Use the files next to this script, or download the repo when piped from curl.
SRC_DIR=""
if [[ -n "$SCRIPT" && -f "$SCRIPT" ]]; then
  SRC_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
fi
if [[ -z "$SRC_DIR" || ! -f "$SRC_DIR/app/netbae.py" ]]; then
  SRC_DIR=$(mktemp -d)
  trap 'rm -rf "$SRC_DIR"' EXIT
  c_info "Downloading netBae ($NETBAE_REPO@$NETBAE_REF)"
  curl -fsSL "https://github.com/$NETBAE_REPO/archive/$NETBAE_REF.tar.gz" | tar -xz -C "$SRC_DIR" --strip-components=1 \
    || die "could not download https://github.com/$NETBAE_REPO"
  [[ -f "$SRC_DIR/app/netbae.py" ]] || die "downloaded archive does not contain app/netbae.py"
fi

# ---------------------------------------------------------------- official Ookla speedtest CLI
is_ookla() { "$1" --version 2>/dev/null | grep -q "Ookla"; }
find_ookla() {
  local b
  for b in /usr/bin/speedtest /usr/local/bin/speedtest /opt/homebrew/bin/speedtest; do
    if [[ -x $b ]] && is_ookla "$b"; then echo "$b"; return 0; fi
  done
  return 1
}

# Preferred: Ookla's official package repository (gets updates with the rest of the system).
install_speedtest_repo() {
  [[ $(uname -m) == armv6l ]] && return 1   # Ookla's armhf package needs ARMv7+; use the armel tarball
  case $PM in
    apt)
      # shellcheck disable=SC1091
      . /etc/os-release
      local os=debian dist=${VERSION_CODENAME:-bookworm}
      if [[ ${ID:-} == ubuntu || ${ID_LIKE:-} == *ubuntu* ]]; then os=ubuntu; dist=${UBUNTU_CODENAME:-$dist}; fi
      # The binary is static, so releases Ookla hasn't published for use the nearest supported one.
      case "$os/$dist" in
        debian/bullseye|debian/bookworm|debian/trixie|ubuntu/jammy) ;;
        ubuntu/*) dist=jammy ;;
        *) os=debian; dist=bookworm ;;
      esac
      c_info "Adding Ookla's official apt repository ($os/$dist)"
      mkdir -p /etc/apt/keyrings
      curl -fsSL "$OOKLA_REPO/gpgkey" | gpg --dearmor --yes -o /etc/apt/keyrings/ookla_speedtest-cli.gpg || return 1
      echo "deb [signed-by=/etc/apt/keyrings/ookla_speedtest-cli.gpg] $OOKLA_REPO/$os/ $dist main" \
        >/etc/apt/sources.list.d/ookla_speedtest-cli.list
      # Ookla's docs: the unofficial python "speedtest-cli" package conflicts with it
      if dpkg -s speedtest-cli >/dev/null 2>&1; then apt-get remove -y -qq speedtest-cli >/dev/null; fi
      if ! { apt-get update -qq && apt-get install -y -qq speedtest >/dev/null; }; then
        rm -f /etc/apt/sources.list.d/ookla_speedtest-cli.list; apt-get update -qq || true; return 1
      fi
      ;;
    dnf|yum)
      # Ookla's repo is built for RHEL 9; its unsigned-digest rpm is refused by Fedora's rpm policy.
      grep -qx 'ID=fedora' /etc/os-release 2>/dev/null && return 1
      c_info "Adding Ookla's official yum repository"
      cat >/etc/yum.repos.d/ookla_speedtest-cli.repo <<EOF
[ookla_speedtest-cli]
name=ookla_speedtest-cli
baseurl=$OOKLA_REPO/el/9/\$basearch
repo_gpgcheck=1
gpgcheck=0
enabled=1
gpgkey=$OOKLA_REPO/gpgkey
sslverify=1
metadata_expire=300
EOF
      if rpm -q speedtest-cli >/dev/null 2>&1; then $PM remove -y -q speedtest-cli; fi
      # Only from Ookla's repo: Fedora ships an unrelated "speedtest" package (a desktop app).
      $PM install -y -q --disablerepo='*' --enablerepo=ookla_speedtest-cli speedtest || { rm -f /etc/yum.repos.d/ookla_speedtest-cli.repo; return 1; }
      ;;
    brew)
      [[ -n $BREW ]] || { c_warn "Homebrew not found - install it from https://brew.sh to get the speedtest CLI"; return 1; }
      c_info "Installing the Ookla speedtest CLI with Homebrew (teamookla/speedtest)"
      brew_run tap teamookla/speedtest >/dev/null || return 1
      # --force: Ookla's documented way past the unrelated python "speedtest-cli" formula
      brew_run install --force teamookla/speedtest/speedtest || return 1
      ;;
    *) return 1 ;;
  esac
}

# Fallback: Ookla's official release tarball from install.speedtest.net.
install_speedtest_tarball() {
  local m arch tmp url
  m=$(uname -m)
  # A 64-bit kernel can run a 32-bit userland (common on Raspberry Pi), so prefer dpkg's view.
  if command -v dpkg >/dev/null; then
    case $(dpkg --print-architecture) in
      arm64) m=aarch64 ;; armhf) [[ $m == armv6l ]] || m=armv7l ;; armel) m=armv6l ;; amd64) m=x86_64 ;; i386) m=i686 ;;
    esac
  fi
  case $m in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    armv7l|armv8l) arch=armhf ;;
    armv6l) arch=armel ;;
    i386|i686) arch=i386 ;;
    *) c_warn "Ookla has no speedtest build for '$m'"; return 1 ;;
  esac
  url="https://install.speedtest.net/app/cli/ookla-speedtest-${SPEEDTEST_VERSION}-linux-${arch}.tgz"
  tmp=$(mktemp -d)
  c_info "Installing Ookla speedtest CLI from the official release tarball ($arch)"
  curl -fsSL "$url" -o "$tmp/st.tgz" || { rm -rf "$tmp"; c_warn "download failed: $url"; return 1; }
  tar -xzf "$tmp/st.tgz" -C "$tmp"
  install -m 0755 "$tmp/speedtest" /usr/local/bin/speedtest
  rm -rf "$tmp"
}

if ST=$(find_ookla); then
  c_info "Ookla speedtest CLI already installed: $ST ($("$ST" --version | head -1))"
elif install_speedtest_repo && ST=$(find_ookla); then
  c_info "Installed Ookla speedtest CLI from the official repository: $ST"
elif [[ $OS == Linux ]] && install_speedtest_tarball && ST=$(find_ookla); then
  c_info "Installed Ookla speedtest CLI: $ST"
else
  ST=""
  c_warn "Could not install the Ookla speedtest CLI - speedtests will show errors until it is installed"
fi

# ---------------------------------------------------------------- user + files
# macOS has no useradd: create a hidden system user + group (ID < 500) with dscl.
mac_create_user() {
  local id gid used
  if ! dscl . -read "/Groups/$SVC_USER" >/dev/null 2>&1 || ! dscl . -read "/Users/$SVC_USER" >/dev/null 2>&1; then
    used=$( { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{print $2}')
    id=400
    while grep -qx "$id" <<<"$used"; do id=$((id + 1)); done
  fi
  if ! dscl . -read "/Groups/$SVC_USER" >/dev/null 2>&1; then
    dscl . -create "/Groups/$SVC_USER" PrimaryGroupID "$id"
    dscl . -create "/Groups/$SVC_USER" RealName "netBae"
    dscl . -create "/Groups/$SVC_USER" Password '*'
  fi
  gid=$(dscl . -read "/Groups/$SVC_USER" PrimaryGroupID | awk '{print $2}')
  if ! dscl . -read "/Users/$SVC_USER" >/dev/null 2>&1; then
    dscl . -create "/Users/$SVC_USER" UniqueID "$id"
    dscl . -create "/Users/$SVC_USER" PrimaryGroupID "$gid"
    dscl . -create "/Users/$SVC_USER" RealName "netBae"
    dscl . -create "/Users/$SVC_USER" NFSHomeDirectory "$DATA_DIR"
    dscl . -create "/Users/$SVC_USER" UserShell /usr/bin/false
    dscl . -create "/Users/$SVC_USER" Password '*'
    dscl . -create "/Users/$SVC_USER" IsHidden 1
  fi
}

if ! id "$SVC_USER" >/dev/null 2>&1; then
  c_info "Creating service user '$SVC_USER'"
  if [[ $OS == Darwin ]]; then
    mac_create_user
  else
    NOLOGIN=$(command -v nologin || echo /bin/false)
    useradd --system --home-dir "$DATA_DIR" --create-home --shell "$NOLOGIN" "$SVC_USER"
  fi
fi
as_svc_user() {
  if [[ $OS != Darwin ]] && command -v runuser >/dev/null; then runuser -u "$SVC_USER" -- "$@"
  elif command -v sudo >/dev/null; then sudo -u "$SVC_USER" "$@"
  else su -s /bin/sh "$SVC_USER" -c '"$0" "$@"' "$@"; fi
}
mkdir -p "$APP_DIR" "$CONF_DIR" "$DATA_DIR" /usr/local/bin
chown "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

OLD_VERSION=""
if [[ -f "$APP_DIR/netbae.py" ]]; then
  OLD_VERSION=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$APP_DIR/netbae.py")
fi
NEW_VERSION=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$SRC_DIR/app/netbae.py")
if [[ -n "$OLD_VERSION" ]]; then
  c_info "Updating netBae $OLD_VERSION -> $NEW_VERSION (config and data are kept)"
else
  c_info "Installing netBae $NEW_VERSION to $APP_DIR"
fi
VENDOR_BACKUP=""
if [[ -d "$APP_DIR/static/vendor" ]]; then VENDOR_BACKUP=$(mktemp -d); cp -a "$APP_DIR/static/vendor/." "$VENDOR_BACKUP/"; fi
rm -rf "$APP_DIR/static"
cp -a "$SRC_DIR/app/." "$APP_DIR/"
install -m 0755 "$SRC_DIR/uninstall.sh" "$APP_DIR/uninstall.sh"
sed "s#__NETBAE_REPO__#$NETBAE_REPO#" "$SRC_DIR/bin/netbae" >/usr/local/bin/netbae
chmod 0755 /usr/local/bin/netbae
mkdir -p "$APP_DIR/static/vendor"
if [[ -n "$VENDOR_BACKUP" ]]; then cp -a "$VENDOR_BACKUP/." "$APP_DIR/static/vendor/"; rm -rf "$VENDOR_BACKUP"; fi

# Chart.js is served from the box itself so the dashboard still works when the internet is down.
c_info "Downloading Chart.js for offline use"
curl -fsSL "$CHARTJS_URL" -o "$APP_DIR/static/vendor/chart.umd.min.js.new" \
  && mv "$APP_DIR/static/vendor/chart.umd.min.js.new" "$APP_DIR/static/vendor/chart.umd.min.js" \
  || c_warn "Chart.js download failed - browsers will fall back to the CDN"
curl -fsSL "$ADAPTER_URL" -o "$APP_DIR/static/vendor/chartjs-adapter-date-fns.bundle.min.js.new" \
  && mv "$APP_DIR/static/vendor/chartjs-adapter-date-fns.bundle.min.js.new" "$APP_DIR/static/vendor/chartjs-adapter-date-fns.bundle.min.js" \
  || c_warn "date adapter download failed - browsers will fall back to the CDN"
rm -f "$APP_DIR"/static/vendor/*.new
chmod -R a+rX "$APP_DIR"

# The shipped config uses the Linux database path; point it at this platform's data dir.
default_config() { sed "s#/var/lib/netbae/#$DATA_DIR/#" "$SRC_DIR/config.toml"; }
if [[ -f "$CONF_DIR/config.toml" ]]; then
  c_info "Keeping existing $CONF_DIR/config.toml (new defaults saved as config.toml.default)"
  default_config >"$CONF_DIR/config.toml.default"
else
  default_config >"$CONF_DIR/config.toml"
fi
chmod 644 "$CONF_DIR/config.toml"

as_svc_user "$PY" "$APP_DIR/netbae.py" -c "$CONF_DIR/config.toml" --check-config >/dev/null \
  || die "config check failed - fix $CONF_DIR/config.toml and re-run"
PORT=$("$PY" "$APP_DIR/netbae.py" -c "$CONF_DIR/config.toml" --print-port 2>/dev/null)

# Who listens on a TCP port (empty if it's free). Call once netBae itself is stopped.
port_holder() {
  if [[ $OS == Darwin ]]; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1 || true
  elif command -v ss >/dev/null; then
    local line name
    line=$(ss -Hltnp "sport = :$1" 2>/dev/null | head -1)
    [[ -z "$line" ]] && return
    name=$(grep -o 'users:(("[^"]*"' <<<"$line" | cut -d'"' -f2)
    echo "${name:-another program}"
  fi
}

# If the configured port is taken, move to the next free one and save it in the config.
pick_port() {
  local holder p=$PORT
  holder=$(port_holder "$p")
  [[ -z "$holder" ]] && return
  for ((p = PORT + 1; p < PORT + 20; p++)); do
    if [[ -z "$(port_holder "$p")" ]]; then
      c_warn "port $PORT is used by '$holder' - using port $p instead (saved as [web] port in $CONF_DIR/config.toml)"
      sed -E "s/^port *= *[0-9]+/port = $p/" "$CONF_DIR/config.toml" >"$CONF_DIR/config.toml.tmp"
      cat "$CONF_DIR/config.toml.tmp" >"$CONF_DIR/config.toml" && rm -f "$CONF_DIR/config.toml.tmp"
      PORT=$p
      return
    fi
  done
  die "port $PORT and the 19 after it are all in use. Set a free [web] port in $CONF_DIR/config.toml and re-run."
}

# ---------------------------------------------------------------- macOS: launchd
install_macos_service() {
  # Stop the running copy first (bootout is asynchronous, so wait for it to go away).
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  for _ in $(seq 20); do launchctl print "system/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
  # A copy started by hand (not by launchd) would still hold the port: stop any leftover netBae process.
  if pkill -f "$APP_DIR/netbae.py" 2>/dev/null; then c_info "Stopped a leftover netBae process"; sleep 2; fi

  pick_port

  # launchd opens these paths after switching to the service user.  Set an
  # explicit traversable mode instead of inheriting the invoking shell's umask.
  install -d -m 0755 "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  chown "$SVC_USER:$SVC_USER" "$LOG_FILE"
  chmod 640 "$LOG_FILE"
  # rotate the log at 1 MB, keep 5 compressed copies
  echo "$LOG_FILE  $SVC_USER:$SVC_USER  640  5  1024  *  NJ" >/etc/newsyslog.d/netbae.conf

  # A LaunchDaemon (not a per-user LaunchAgent) so netBae runs from boot without anyone logged in,
  # like the Linux service. It runs as the unprivileged _netbae user: macOS 10.14+ lets any user
  # listen on ports below 1024 on all interfaces, and ping needs no privileges.
  c_info "Installing launchd daemon ($PLIST)"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$APP_DIR/netbae.py</string>
    <string>-c</string>
    <string>$CONF_DIR/config.toml</string>
  </array>
  <key>UserName</key><string>$SVC_USER</string>
  <key>GroupName</key><string>$SVC_USER</string>
  <key>WorkingDirectory</key><string>$DATA_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$DATA_DIR</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
EOF
  chown root:wheel "$PLIST"
  chmod 644 "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "generated $PLIST is invalid"
  launchctl enable "system/$LABEL"
  launchctl bootstrap system "$PLIST" || die "launchctl bootstrap failed (see $LOG_FILE)"

  # The application firewall would silently drop dashboard connections to a daemon; allow python.
  local fw=/usr/libexec/ApplicationFirewall/socketfilterfw py_real app
  if [[ -x $fw ]] && "$fw" --getglobalstate 2>/dev/null | grep -qi enabled; then
    py_real=$("$PY" -c 'import os, sys; print(os.path.realpath(sys.executable))')
    c_info "Allowing $py_real through the macOS firewall"
    for app in "$py_real" "$(dirname "$py_real")/../Resources/Python.app"; do
      [[ -e $app ]] || continue
      "$fw" --add "$app" >/dev/null 2>&1 || true
      "$fw" --unblockapp "$app" >/dev/null 2>&1 || true
    done
  fi

  sleep 3
  if launchctl print "system/$LABEL" 2>/dev/null | grep -q "state = running"; then
    local iface ip host suffix=""
    iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    ip=$(ipconfig getifaddr "${iface:-en0}" 2>/dev/null || true)
    host=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
    [[ $PORT == 80 ]] || suffix=":$PORT"
    echo
    if [[ -n "$OLD_VERSION" ]]; then c_info "netBae updated to $NEW_VERSION and running!"; else c_info "netBae is running!"; fi
    echo "    Dashboard:  http://${ip:-<this-mac-ip>}$suffix"
    echo "                http://$host.local$suffix"
    echo "    Config:     netbae config     ($CONF_DIR/config.toml)"
    echo "    Logs:       netbae logs       ($LOG_FILE)"
    echo "    Update:     netbae update     (or re-run the install command)"
    [[ -n "$ST" ]] || c_warn "Ookla speedtest CLI is missing - see https://www.speedtest.net/apps/cli"
  else
    tail -n 30 "$LOG_FILE" || true
    die "netBae failed to start (see log above)"
  fi
}

if [[ $OS == Darwin ]]; then
  install_macos_service
  exit 0
fi

# ---------------------------------------------------------------- port check
systemctl stop netbae 2>/dev/null || true
if pkill -f "$APP_DIR/netbae.py" 2>/dev/null; then c_info "Stopped a leftover netBae process"; sleep 2; fi
pick_port

# ---------------------------------------------------------------- systemd
c_info "Installing systemd service"
cat >/etc/systemd/system/netbae.service <<EOF
[Unit]
Description=netBae internet connection monitor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
ExecStart=$PY $APP_DIR/netbae.py -c $CONF_DIR/config.toml
Restart=always
RestartSec=5
# CAP_NET_BIND_SERVICE lets the unprivileged service listen on port 80; CAP_NET_RAW is for ping.
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_RAW
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable netbae >/dev/null 2>&1
systemctl restart netbae

# Open the firewall if one is active
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  c_info "Allowing port $PORT/tcp in ufw"; ufw allow "$PORT/tcp" >/dev/null
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  c_info "Allowing port $PORT/tcp in firewalld"
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null && firewall-cmd --reload >/dev/null
fi

sleep 2
if systemctl is-active --quiet netbae; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}') || IP=""  # Fedora has no hostname command by default
  [[ -n "$IP" ]] || IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
  SUFFIX=""; [[ $PORT == 80 ]] || SUFFIX=":$PORT"
  echo
  if [[ -n "$OLD_VERSION" ]]; then c_info "netBae updated to $NEW_VERSION and running!"; else c_info "netBae is running!"; fi
  echo "    Dashboard:  http://${IP:-<this-machine-ip>}$SUFFIX"
  echo "                http://$(uname -n).local$SUFFIX  (if mDNS/avahi is available)"
  echo "    Config:     netbae config     ($CONF_DIR/config.toml)"
  echo "    Logs:       netbae logs"
  echo "    Update:     netbae update     (or re-run the install command)"
  [[ -n "$ST" ]] || c_warn "Ookla speedtest CLI is missing - see https://www.speedtest.net/apps/cli"
else
  journalctl -u netbae -n 30 --no-pager || true
  die "netBae failed to start (see log above)"
fi
