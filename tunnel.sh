#!/usr/bin/env bash
# netbae tunnel - share the read-only public dashboard through Cloudflare or Tailscale without
# opening a port on your router. Installed next to netbae.py; run it as `netbae tunnel ...`.
#
#   netbae tunnel                         choose interactively
#   netbae tunnel quick                   temporary https://<random>.trycloudflare.com address (no account)
#   netbae tunnel cloudflare <hostname>   permanent tunnel on your own domain, e.g. netbae.example.com
#   netbae tunnel cloudflare --token <t>  run a tunnel you created in the Cloudflare dashboard
#   netbae tunnel tailscale               Tailscale Funnel: https://<machine>.<tailnet>.ts.net
#   netbae tunnel status
#   netbae tunnel off                     stop sharing and turn the public dashboard off
set -euo pipefail
if [[ $EUID -ne 0 ]]; then exec sudo bash "$0" "$@"; fi

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

OS=$(uname -s)
if [[ $OS == Darwin ]]; then
  CONF_DIR=/usr/local/etc/netbae
  SVC_USER=_netbae
  LABEL=com.github.netbae
  TLABEL=$LABEL.tunnel
  TPLIST=/Library/LaunchDaemons/$TLABEL.plist
  TLOG=/usr/local/var/log/netbae-tunnel.log
  PY=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "/Library/LaunchDaemons/$LABEL.plist" 2>/dev/null || echo python3)
else
  CONF_DIR=/etc/netbae
  SVC_USER=netbae
  UNIT=/etc/systemd/system/netbae-tunnel.service
  PY=python3
fi
CONF=$CONF_DIR/config.toml
CF_DIR=$CONF_DIR/cloudflared
[[ -f $CONF ]] || die "netBae isn't installed here ($CONF not found)"

as_svc() { if [[ $OS == Darwin ]] || ! command -v runuser >/dev/null; then sudo -u "$SVC_USER" "$@"; else runuser -u "$SVC_USER" -- "$@"; fi; }
ask() {  # ask "question" default -> answer (reads the terminal, also when piped)
  local a
  read -r -p "$1 " a </dev/tty || a=""
  echo "${a:-$2}"
}

# ---------------------------------------------------------------- config
conf_get() {  # conf_get section key -> value without quotes or comment
  sed -n "/^\[$1\]/,/^\[/{s/^$2 *= *\"\{0,1\}\([^\"# ]*\).*/\1/p;}" "$CONF" | head -1
}
conf_set() {  # conf_set section key toml-value: replace the key, add it to the section, or add the section
  local tmp="$CONF.tmp"
  awk -v sec="[$1]" -v key="$2" -v val="$3" '
    $0 == sec { print; insec = 1; seen = 1; next }
    /^\[/ { if (insec && !done) { print key " = " val; done = 1 } insec = 0 }
    insec && !done && $0 ~ "^" key " *=" {
      c = index($0, "#"); print key " = " val (c ? "   " substr($0, c) : ""); done = 1; next }
    { print }
    END { if (!done) { if (!seen) print "\n" sec; print key " = " val } }' "$CONF" >"$tmp"
  cat "$tmp" >"$CONF" && rm -f "$tmp"
}
PPORT=$(conf_get public port); PPORT=${PPORT:-8080}

restart_netbae() {
  if [[ $OS == Darwin ]]; then launchctl kickstart -k "system/$LABEL"; else systemctl restart netbae; fi
}
public_on() {
  local before
  before=$(cat "$CONF")
  conf_set public enabled true
  conf_set public host '"127.0.0.1"'   # only the tunnel (on this machine) can reach it
  conf_set public port "$PPORT"
  as_svc "$PY" "$(app_dir)/netbae.py" -c "$CONF" --check-config >/dev/null || die "the config has errors - fix $CONF and re-run"
  c_info "Public dashboard: on, at http://127.0.0.1:$PPORT (only reachable from this machine)"
  if [[ $(cat "$CONF") != "$before" ]] || ! curl -fsS --max-time 2 "http://127.0.0.1:$PPORT/api/config" >/dev/null 2>&1; then
    restart_netbae
  fi
  for _ in $(seq 30); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PPORT/api/config" 2>/dev/null | grep -q '"public":true' && return 0
    sleep 1
  done
  die "the public dashboard didn't come up on port $PPORT - see: netbae logs"
}
public_off() {
  conf_set public enabled false
  restart_netbae
  c_info "Public dashboard: off"
}
app_dir() { if [[ $OS == Darwin ]]; then echo /usr/local/lib/netbae; else echo /opt/netbae; fi; }

# ---------------------------------------------------------------- cloudflared
find_cf() { command -v cloudflared 2>/dev/null || ls /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared 2>/dev/null | head -1; }
install_cloudflared() {
  CF=$(find_cf || true)
  [[ -n $CF ]] && return
  c_info "Installing cloudflared (Cloudflare's tunnel program)"
  if [[ $OS == Darwin ]]; then
    local brew
    brew=$(ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1)
    [[ -n $brew && -n ${SUDO_USER:-} ]] || die "install Homebrew (https://brew.sh), then: brew install cloudflared"
    sudo -u "$SUDO_USER" "$brew" install cloudflared
  elif command -v apt-get >/dev/null; then
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      >/etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null || install_cloudflared_binary
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo -o /etc/yum.repos.d/cloudflared.repo
    "$(command -v dnf || command -v yum)" install -y -q cloudflared || install_cloudflared_binary
  else
    install_cloudflared_binary
  fi
  CF=$(find_cf || true)
  [[ -n $CF ]] || die "couldn't install cloudflared - see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  c_info "Installed $("$CF" --version 2>/dev/null | head -1)"
}
install_cloudflared_binary() {  # Cloudflare's own release build, for distros without their package repo
  local m
  m=$(uname -m)
  if command -v dpkg >/dev/null; then m=$(dpkg --print-architecture); fi
  case $m in
    x86_64|amd64) m=amd64 ;; aarch64|arm64) m=arm64 ;; armv7l|armv6l|armhf|armel) m=arm ;; i?86) m=386 ;;
    *) die "no cloudflared build for $m" ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$m" -o /usr/local/bin/cloudflared
  chmod 0755 /usr/local/bin/cloudflared
}

# netbae-tunnel: our own service running cloudflared as the unprivileged netBae user
cf_service() {  # cf_service <args after "cloudflared tunnel --no-autoupdate">
  if [[ $OS == Darwin ]]; then
    local args="" a
    for a in "$CF" tunnel --no-autoupdate "$@"; do args+="    <string>$a</string>"$'\n'; done
    touch "$TLOG"; chown "$SVC_USER" "$TLOG"; chmod 640 "$TLOG"
    cat >"$TPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TLABEL</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>UserName</key><string>$SVC_USER</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TLOG</string>
  <key>StandardErrorPath</key><string>$TLOG</string>
</dict>
</plist>
EOF
    launchctl bootout "system/$TLABEL" 2>/dev/null || true
    launchctl bootstrap system "$TPLIST"
  else
    cat >"$UNIT" <<EOF
[Unit]
Description=netBae public dashboard tunnel (Cloudflare)
After=network-online.target netbae.service
Wants=network-online.target

[Service]
User=$SVC_USER
ExecStart=$CF tunnel --no-autoupdate $*
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable netbae-tunnel >/dev/null 2>&1
    systemctl restart netbae-tunnel
  fi
}
cf_service_remove() {
  if [[ $OS == Darwin ]]; then
    [[ -f $TPLIST ]] || return 1
    launchctl bootout "system/$TLABEL" 2>/dev/null || true
    rm -f "$TPLIST"
  else
    [[ -f $UNIT ]] || return 1
    systemctl disable --now netbae-tunnel >/dev/null 2>&1 || true
    rm -f "$UNIT"; systemctl daemon-reload
  fi
}
cf_service_active() {
  if [[ $OS == Darwin ]]; then launchctl print "system/$TLABEL" 2>/dev/null | grep -q 'state = running'
  else systemctl is-active --quiet netbae-tunnel; fi
}
cf_dir() {
  install -d -m 0750 "$CF_DIR"
  chown "root:$(id -gn "$SVC_USER")" "$CF_DIR"
}
wait_for_url() {  # wait_for_url https://host - the dashboard answering through the tunnel
  c_info "Waiting for $1 to answer (DNS can take a minute)"
  for _ in $(seq 40); do
    if curl -fsS --max-time 5 "$1/api/config" 2>/dev/null | grep -q '"public":true'; then
      echo; c_info "Your public dashboard: $1"; return 0
    fi
    sleep 3
  done
  c_warn "no answer yet from $1. It may still be setting up; check: netbae tunnel status"
}

cmd_quick() {
  install_cloudflared
  public_on
  echo
  c_info "Starting a temporary tunnel. Your address (https://....trycloudflare.com) appears in the box below."
  echo "    It changes every time this runs, and stops when you press Ctrl-C."
  echo "    The public dashboard stays on (only reachable from this machine) until: netbae tunnel off"
  echo
  as_svc "$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$PPORT"
}

cmd_cloudflare() {
  local host="" token=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --token) token=${2:-}; shift 2 || true ;;
      --token=*) token=${1#*=}; shift ;;
      *) host=$1; shift ;;
    esac
  done
  install_cloudflared
  cf_dir
  if [[ -n $token ]]; then  # a tunnel set up in the Cloudflare dashboard
    printf '%s' "$token" >"$CF_DIR/token"
    chown "root:$(id -gn "$SVC_USER")" "$CF_DIR/token"; chmod 0640 "$CF_DIR/token"
    public_on
    cf_service run --token-file "$CF_DIR/token"
    sleep 8
    if cf_service_active; then
      c_info "Tunnel running. In the Cloudflare dashboard, give it a public hostname with service http://127.0.0.1:$PPORT"
    else
      c_warn "the tunnel isn't connecting - check the token. Log: $([[ $OS == Darwin ]] && echo "$TLOG" || echo 'journalctl -u netbae-tunnel')"
    fi
    return
  fi
  [[ -n $host ]] || host=$(ask "Hostname for the dashboard (on a domain in your Cloudflare account, e.g. netbae.example.com):" "")
  host=${host#https://}; host=${host%%/*}
  [[ $host == *.* ]] || die "give a full hostname, e.g. netbae.example.com"

  local cert="$CF_DIR/cert.pem" name id
  if [[ ! -f $cert ]]; then
    c_info "Sign in to Cloudflare: open the link below and choose the domain for $host"
    rm -rf "$CF_DIR/.home"
    HOME="$CF_DIR/.home" "$CF" tunnel login
    mv "$CF_DIR/.home/.cloudflared/cert.pem" "$cert"; rm -rf "$CF_DIR/.home"
    chmod 0600 "$cert"
  fi
  name="netbae-$(uname -n | cut -d. -f1 | tr '[:upper:]' '[:lower:]')"
  cfj() { "$CF" tunnel --origincert "$cert" "$@"; }
  id=$(cfj list -o json -n "$name" 2>/dev/null | "$PY" -c 'import json,sys; t=json.load(sys.stdin) or []; print(t[0]["id"] if t else "")')
  if [[ -n $id ]]; then
    c_info "Using your existing tunnel '$name'"
    cfj token --cred-file "$CF_DIR/credentials.json" "$id" >/dev/null
  else
    c_info "Creating tunnel '$name'"
    cfj create --cred-file "$CF_DIR/credentials.json" "$name" >/dev/null
    id=$(cfj list -o json -n "$name" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
  fi
  chown "root:$(id -gn "$SVC_USER")" "$CF_DIR/credentials.json"; chmod 0640 "$CF_DIR/credentials.json"
  if ! cfj route dns "$id" "$host" 2>/tmp/netbae-route.$$; then
    if grep -qi 'already' /tmp/netbae-route.$$ && [[ $(ask "A DNS record for $host already exists. Replace it? [y/N]" n) == [yY]* ]]; then
      cfj route dns --overwrite-dns "$id" "$host" >/dev/null
    else
      cat /tmp/netbae-route.$$ >&2; rm -f /tmp/netbae-route.$$; die "couldn't point $host at the tunnel"
    fi
  fi
  rm -f /tmp/netbae-route.$$
  cat >"$CF_DIR/config.yml" <<EOF
# Written by netbae tunnel. The tunnel only reaches netBae's read-only public port.
tunnel: $id
credentials-file: $CF_DIR/credentials.json
ingress:
  - hostname: $host
    service: http://127.0.0.1:$PPORT
  - service: http_status:404
EOF
  chmod 0644 "$CF_DIR/config.yml"
  public_on
  cf_service --config "$CF_DIR/config.yml" run
  wait_for_url "https://$host"
  echo "    Only invited people? Add a Cloudflare Access application for $host (free for up to 50 users)."
}

# ---------------------------------------------------------------- tailscale
find_ts() {
  command -v tailscale 2>/dev/null || ls /Applications/Tailscale.app/Contents/MacOS/Tailscale 2>/dev/null || true
}
cmd_tailscale() {
  TS=$(find_ts)
  if [[ -z $TS ]]; then
    [[ $OS == Darwin ]] && die "install Tailscale from https://tailscale.com/download/mac, sign in, then re-run: netbae tunnel tailscale"
    c_info "Installing Tailscale (official install script)"
    curl -fsSL https://tailscale.com/install.sh | sh
    TS=$(find_ts)
  fi
  [[ -n $TS ]] || die "couldn't find the tailscale command"
  if ! "$TS" status >/dev/null 2>&1; then
    c_info "Sign in to Tailscale: open the link below"
    "$TS" up
  fi
  public_on
  c_info "Turning on Funnel for port $PPORT (the first time, Tailscale may give you a link to allow Funnel)"
  "$TS" funnel --bg "$PPORT"
  local url
  url=$("$TS" status --json 2>/dev/null | "$PY" -c 'import json,sys; print("https://" + json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
  [[ -n $url ]] && wait_for_url "$url" || "$TS" funnel status
}

# ---------------------------------------------------------------- status / off
cmd_status() {
  local en
  en=$(conf_get public enabled)
  echo "Public dashboard: ${en:-false} (host $(conf_get public host), port $PPORT)"
  if [[ -f ${UNIT:-$TPLIST} ]]; then
    local how="your own domain"
    [[ -f $CF_DIR/token ]] && [[ $(cat "${UNIT:-$TPLIST}") == *token-file* ]] && how="a Cloudflare dashboard tunnel"
    echo "Cloudflare Tunnel: $(cf_service_active && echo running || echo 'not running') ($how)"
    [[ -f $CF_DIR/config.yml ]] && sed -n 's/^  - hostname: /    https:\/\//p' "$CF_DIR/config.yml"
  else
    echo "Cloudflare Tunnel: not set up"
  fi
  TS=$(find_ts)
  if [[ -n $TS ]]; then echo "Tailscale Funnel:"; "$TS" funnel status 2>&1 | sed 's/^/    /'; fi
}
cmd_off() {
  if cf_service_remove; then c_info "Cloudflare Tunnel stopped and removed (your login and tunnel are kept in $CF_DIR)"; fi
  TS=$(find_ts)
  if [[ -n $TS ]] && "$TS" funnel status 2>/dev/null | grep -q "127.0.0.1:$PPORT"; then
    "$TS" funnel --https=443 off >/dev/null 2>&1 || "$TS" funnel reset
    c_info "Tailscale Funnel turned off"
  fi
  public_off
}

case "${1:-}" in
  quick) cmd_quick ;;
  cloudflare|cf) shift; cmd_cloudflare "$@" ;;
  tailscale|ts|funnel) cmd_tailscale ;;
  status) cmd_status ;;
  off|stop) cmd_off ;;
  "")
    cat <<'EOF'
Share the read-only public dashboard without opening a port on your router:

  1) Quick look       temporary https://<random>.trycloudflare.com address, no account needed
  2) Your own domain  permanent https://netbae.example.com through a free Cloudflare Tunnel
  3) Tailscale        permanent https://<machine>.<tailnet>.ts.net through Tailscale Funnel

EOF
    case $(ask "Choose 1, 2 or 3:" "") in
      1) cmd_quick ;; 2) cmd_cloudflare ;; 3) cmd_tailscale ;; *) die "nothing chosen" ;;
    esac
    ;;
  *) sed -n '2,12s/^# \{0,1\}//p' "$0"; exit 1 ;;
esac
