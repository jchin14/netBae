#!/usr/bin/env bash
# netBae installer - works on any systemd-based Linux (Raspberry Pi OS, Debian,
# Ubuntu, Fedora/RHEL/Rocky/Alma, Arch, openSUSE) on x86_64, arm64, armhf/armv6, i386.
# Re-running upgrades in place and keeps your config + data.
#
#   From a checkout:   sudo bash install.sh
#   From GitHub:       curl -fsSL https://raw.githubusercontent.com/jchin14/netBae/main/install.sh | sudo bash
set -euo pipefail

NETBAE_REPO="${NETBAE_REPO:-jchin14/netBae}"   # GitHub owner/repo used for curl | bash installs
NETBAE_REF="${NETBAE_REF:-main}"                            # branch or tag to install
APP_DIR=/opt/netbae
CONF_DIR=/etc/netbae
DATA_DIR=/var/lib/netbae
SVC_USER=netbae
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
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die "systemd is required"

# ---------------------------------------------------------------- packages
c_info "Installing system packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 iputils-ping iproute2 curl ca-certificates tar gnupg >/dev/null
  PM=apt
elif command -v dnf >/dev/null; then
  dnf install -y -q python3 iputils iproute curl ca-certificates tar shadow-utils; PM=dnf
elif command -v yum >/dev/null; then
  yum install -y -q python3 iputils iproute curl ca-certificates tar shadow-utils; PM=yum
elif command -v pacman >/dev/null; then
  pacman -Sy --noconfirm --needed python iputils iproute2 curl ca-certificates tar; PM=pacman
elif command -v zypper >/dev/null; then
  zypper -n -q install python3 iputils iproute2 curl ca-certificates tar; PM=zypper
else
  die "unsupported package manager - install python3 (3.8+), ping and curl manually, then re-run"
fi

PY=$(command -v python3) || die "python3 not found"
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
  for b in /usr/bin/speedtest /usr/local/bin/speedtest; do
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
      $PM install -y -q speedtest || { rm -f /etc/yum.repos.d/ookla_speedtest-cli.repo; return 1; }
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
elif install_speedtest_tarball && ST=$(find_ookla); then
  c_info "Installed Ookla speedtest CLI: $ST"
else
  ST=""
  c_warn "Could not install the Ookla speedtest CLI - speedtests will show errors until it is installed"
fi

# ---------------------------------------------------------------- user + files
if ! id "$SVC_USER" >/dev/null 2>&1; then
  c_info "Creating service user '$SVC_USER'"
  NOLOGIN=$(command -v nologin || echo /bin/false)
  useradd --system --home-dir "$DATA_DIR" --create-home --shell "$NOLOGIN" "$SVC_USER"
fi
mkdir -p "$APP_DIR" "$CONF_DIR" "$DATA_DIR"
chown "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

c_info "Installing app to $APP_DIR"
VENDOR_BACKUP=""
if [[ -d "$APP_DIR/static/vendor" ]]; then VENDOR_BACKUP=$(mktemp -d); cp -a "$APP_DIR/static/vendor/." "$VENDOR_BACKUP/"; fi
rm -rf "$APP_DIR/static"
cp -a "$SRC_DIR/app/." "$APP_DIR/"
install -m 0755 "$SRC_DIR/uninstall.sh" "$APP_DIR/uninstall.sh"
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

if [[ -f "$CONF_DIR/config.toml" ]]; then
  c_info "Keeping existing $CONF_DIR/config.toml (new defaults saved as config.toml.default)"
  cp "$SRC_DIR/config.toml" "$CONF_DIR/config.toml.default"
else
  cp "$SRC_DIR/config.toml" "$CONF_DIR/config.toml"
fi
chmod 644 "$CONF_DIR/config.toml"

runuser -u "$SVC_USER" -- "$PY" "$APP_DIR/netbae.py" -c "$CONF_DIR/config.toml" --check-config >/dev/null \
  || die "config check failed - fix $CONF_DIR/config.toml and re-run"
PORT=$("$PY" "$APP_DIR/netbae.py" -c "$CONF_DIR/config.toml" --print-port 2>/dev/null)

# ---------------------------------------------------------------- port check
systemctl stop netbae 2>/dev/null || true
if command -v ss >/dev/null; then
  HOLDER=$(ss -Hltnp "sport = :$PORT" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)
  if [[ -n "$HOLDER" ]]; then
    die "port $PORT is already used by '$HOLDER'. Set a different [web] port in $CONF_DIR/config.toml (e.g. 8080) and re-run."
  fi
fi

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
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -n "$IP" ]] || IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
  SUFFIX=""; [[ $PORT == 80 ]] || SUFFIX=":$PORT"
  echo
  c_info "netBae is running!"
  echo "    Dashboard:  http://${IP:-<this-machine-ip>}$SUFFIX"
  echo "                http://$(hostname).local$SUFFIX  (if mDNS/avahi is available)"
  echo "    Config:     $CONF_DIR/config.toml   (then: sudo systemctl restart netbae)"
  echo "    Logs:       journalctl -u netbae -f"
  [[ -n "$ST" ]] || c_warn "Ookla speedtest CLI is missing - see https://www.speedtest.net/apps/cli"
else
  journalctl -u netbae -n 30 --no-pager || true
  die "netBae failed to start (see log above)"
fi
