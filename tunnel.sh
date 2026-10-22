#!/usr/bin/env bash
# netbae tunnel - share the read-only public dashboard through Cloudflare or Tailscale without
# opening a port on your router. Installed next to netbae.py; run it as `netbae tunnel ...`.
#
#   netbae tunnel                         choose interactively
#   netbae tunnel quick                   temporary https://<random>.trycloudflare.com address (no account)
#   netbae tunnel cloudflare <hostname>   permanent tunnel on your own domain, e.g. netbae.example.com
#                                         (run again or give several to add more; existing ones are kept)
#   netbae tunnel remove <hostname>       stop sharing on one of those hostnames
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
# NixOS (installer-managed): the netbae command passes the Nix package's path. Services come from the NixOS
# configuration, so the tunnel is set in /etc/nixos/netbae-tunnel.nix and turned on with nixos-rebuild.
NIX_OUT=${NETBAE_NIX_OUT:-}
if [[ -n $NIX_OUT ]]; then
  PY=$NIX_OUT/libexec/netbae/python3
  SVC_USER=nobody   # netBae runs as a systemd DynamicUser; the quick tunnel runs as nobody
  NIX_TUNNEL=/etc/nixos/netbae-tunnel.nix
  unset UNIT
fi
CONF=$CONF_DIR/config.toml
CF_DIR=$CONF_DIR/cloudflared
[[ -f $CONF ]] || die "netBae isn't installed here ($CONF not found)"

as_svc() {
  if [[ -n $NIX_OUT ]]; then runuser -u "$SVC_USER" -- env HOME=/tmp "$@"
  elif [[ $OS == Darwin ]] || ! command -v runuser >/dev/null; then sudo -u "$SVC_USER" "$@"
  else runuser -u "$SVC_USER" -- "$@"; fi
}
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
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
public_on() {
  local before p
  before=$(cat "$CONF")
  if ! curl -fsS --max-time 2 "http://127.0.0.1:$PPORT/api/config" 2>/dev/null | grep -q '"public":true' && ! port_free "$PPORT"; then
    for p in $(seq $((PPORT + 1)) $((PPORT + 100))); do port_free "$p" && break; done
    port_free "$p" || die "port $PPORT is used by another program and no free port was found near it"
    c_warn "port $PPORT is used by another program, so the public dashboard uses port $p"
    PPORT=$p
  fi
  conf_set public enabled true
  conf_set public host '"127.0.0.1"'   # only the tunnel (on this machine) can reach it
  conf_set public port "$PPORT"
  check_config >/dev/null || die "the config has errors - fix $CONF and re-run"
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
check_config() {
  if [[ -n $NIX_OUT ]]; then "$NIX_OUT/bin/netbae-server" -c "$CONF" --check-config
  else as_svc "$PY" "$(app_dir)/netbae.py" -c "$CONF" --check-config; fi
}

# ---------------------------------------------------------------- cloudflared
find_cf() { command -v cloudflared 2>/dev/null || ls /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared 2>/dev/null | head -1; }
install_cloudflared() {
  CF=$(find_cf || true)
  if [[ -n $NIX_OUT && -z $CF ]]; then  # nixpkgs' cloudflared, for signing in and the quick tunnel
    c_info "Getting cloudflared from nixpkgs"
    CF=$(nix-build '<nixpkgs>' -A cloudflared --no-out-link 2>/dev/null \
         || nix --extra-experimental-features 'nix-command flakes' build nixpkgs#cloudflared --no-link --print-out-paths)
    CF=$CF/bin/cloudflared
    [[ -x $CF ]] || die "couldn't get cloudflared from nixpkgs"
    return
  fi
  if [[ -n $NIX_OUT ]]; then return; fi  # the tunnel service uses the NixOS module's cloudflared
  if [[ -n $CF ]]; then update_cloudflared; return; fi
  c_info "Installing cloudflared (Cloudflare's tunnel program)"
  if [[ $OS == Darwin ]]; then
    local brew
    brew=$(ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1 || true)
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
update_cloudflared() {  # bring an installed cloudflared up to date from wherever it came from (never fatal)
  local old new brew
  old=$("$CF" --version 2>/dev/null | head -1)
  c_info "Checking for a cloudflared update"
  brew=$(ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1 || true)
  if [[ $OS == Darwin && -n $brew && -n ${SUDO_USER:-} ]] && sudo -u "$SUDO_USER" "$brew" list cloudflared >/dev/null 2>&1; then
    sudo -u "$SUDO_USER" "$brew" upgrade cloudflared >/dev/null 2>&1 || true
  elif [[ $OS != Darwin ]] && command -v dpkg >/dev/null && dpkg -s cloudflared >/dev/null 2>&1; then
    { apt-get update -qq && apt-get install -y -qq --only-upgrade cloudflared; } >/dev/null 2>&1 || true
  elif [[ $OS != Darwin ]] && command -v rpm >/dev/null && rpm -q cloudflared >/dev/null 2>&1; then
    "$(command -v dnf || command -v yum)" upgrade -y -q cloudflared >/dev/null 2>&1 || true
  else
    "$CF" update >/dev/null 2>&1 || true  # Cloudflare's own build replaces itself
  fi
  new=$("$CF" --version 2>/dev/null | head -1)
  if [[ $new != "$old" ]]; then c_info "Updated to $new"; else c_info "${old:-cloudflared} is up to date"; fi
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
  if [[ -n $NIX_OUT ]]; then
    if [[ $* == *--token-file* ]]; then nix_tunnel token keep; else nix_tunnel config keep; fi
  elif [[ $OS == Darwin ]]; then
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
  if [[ -n $NIX_OUT ]]; then
    grep -q 'cloudflare' "$NIX_TUNNEL" 2>/dev/null || return 1
    nix_tunnel none keep
  elif [[ $OS == Darwin ]]; then
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
  if [[ -n $NIX_OUT ]]; then  # netBae's DynamicUser reads config.yml (for its status); secrets stay root-only
    install -d -m 0755 "$CF_DIR"
  else
    install -d -m 0750 "$CF_DIR"
    chown "root:$(id -gn "$SVC_USER")" "$CF_DIR"
  fi
}
secret() {  # secret <file>: readable by the tunnel service only (on NixOS systemd hands it over as root)
  if [[ -n $NIX_OUT ]]; then chown root:root "$1"; chmod 0600 "$1"
  else chown "root:$(id -gn "$SVC_USER")" "$1"; chmod 0640 "$1"; fi
}

# NixOS: the tunnel lives in /etc/nixos/netbae-tunnel.nix, imported by the installer's netbae.nix
nix_tunnel() {  # nix_tunnel <cloudflare: token|config|none|keep> <tailscale: true|false|keep>
  local cf=$1 ts=$2 old="" n=/etc/nixos/netbae.nix
  [[ -f $NIX_TUNNEL ]] && old=$(cat "$NIX_TUNNEL")
  if [[ $cf == keep ]]; then
    cf=none; [[ $old == *tokenFile* ]] && cf=token; [[ $old == *credentialsFile* ]] && cf=config
  fi
  if [[ $ts == keep ]]; then ts=false; [[ $old == *"tailscale = true"* ]] && ts=true; fi
  # netbae.nix from before netBae 1.19.1 doesn't import the tunnel file yet
  if [[ -f $n ]] && ! grep -q netbae-tunnel.nix "$n"; then
    sed -i -e 's|^{ \.\.\. }:$|{ lib, ... }:|' \
      -e 's|imports = \[ \./netbae/nix/module\.nix \];|imports = [ ./netbae/nix/module.nix ] ++ lib.optional (builtins.pathExists ./netbae-tunnel.nix) ./netbae-tunnel.nix;|' "$n"
    grep -q netbae-tunnel.nix "$n" || die "couldn't add netbae-tunnel.nix to the imports in $n"
  fi
  if [[ $cf == none && $ts == false ]]; then
    [[ -f $NIX_TUNNEL ]] || return 0
    rm -f "$NIX_TUNNEL"
  else
    {
      echo "# Written by netbae tunnel and imported by netbae.nix. netbae tunnel off removes it."
      echo "{ ... }:"
      echo "{"
      [[ $ts == true ]] && echo "  services.netbae.tunnel.tailscale = true;"
      case $cf in
        token) printf '  services.netbae.tunnel.cloudflare = {\n    enable = true;\n    tokenFile = "%s";\n  };\n' "$CF_DIR/token" ;;
        config) printf '  services.netbae.tunnel.cloudflare = {\n    enable = true;\n    configFile = "%s";\n    credentialsFile = "%s";\n  };\n' \
                  "$CF_DIR/config.yml" "$CF_DIR/credentials.json" ;;
      esac
      echo "}"
    } >"$NIX_TUNNEL"
  fi
  if [[ -f /etc/nixos/flake.nix && -d /etc/nixos/.git ]]; then
    git -C /etc/nixos add -A netbae.nix netbae-tunnel.nix 2>/dev/null || true  # flakes only see files git knows
  fi
  c_info "Running nixos-rebuild switch"
  if ! nixos-rebuild switch; then
    if [[ -n $old ]]; then printf '%s\n' "$old" >"$NIX_TUNNEL"; else rm -f "$NIX_TUNNEL"; fi
    die "nixos-rebuild failed (see above); $NIX_TUNNEL was put back as it was"
  fi
}
wait_for_url() {  # wait_for_url https://host - the dashboard answering through the tunnel
  c_info "Waiting for $1 to answer (DNS can take a minute)"
  local out
  for _ in $(seq 40); do
    out=$(curl -fsS --max-time 5 "$1/api/config" 2>/dev/null || true)
    if [[ $out == *'"public":true'* ]]; then
      echo; c_info "Your public dashboard: $1"; return 0
    fi
    # the local resolver (often the router) may have cached "no such name" from before the
    # DNS record existed, so also ask Cloudflare's DNS directly
    out=$(curl -fsS --max-time 5 --doh-url https://1.1.1.1/dns-query "$1/api/config" 2>/dev/null || true)
    if [[ $out == *'"public":true'* ]]; then
      echo; c_info "Your public dashboard: $1"
      echo "    It may take a few more minutes to open on this network while your router's DNS cache catches up."
      return 0
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
  local token="" h i hosts=()
  while [[ $# -gt 0 ]]; do
    case $1 in
      --token) token=${2:-}; shift 2 || true ;;
      --token=*) token=${1#*=}; shift ;;
      *) hosts+=("$1"); shift ;;
    esac
  done
  install_cloudflared
  cf_dir
  if [[ -n $token ]]; then  # a tunnel set up in the Cloudflare dashboard
    printf '%s' "$token" >"$CF_DIR/token"
    secret "$CF_DIR/token"
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
  [[ ${#hosts[@]} -gt 0 ]] || read -r -a hosts <<<"$(ask "Hostname for the dashboard (on a domain in your Cloudflare account, e.g. netbae.example.com; several separated by spaces):" "")"
  [[ ${#hosts[@]} -gt 0 ]] || die "give a full hostname, e.g. netbae.example.com"
  for i in "${!hosts[@]}"; do
    h=${hosts[$i]#https://}; h=${h#http://}; hosts[i]=${h%%/*}
    [[ ${hosts[$i]} == *.* ]] || die "give a full hostname, e.g. netbae.example.com (not ${hosts[$i]})"
  done

  local cert="$CF_DIR/cert.pem" name id
  if [[ ! -f $cert ]]; then
    c_info "Sign in to Cloudflare: open the link below and choose the domain for ${hosts[0]}"
    rm -rf "$CF_DIR/.home"; install -d -m 0700 "$CF_DIR/.home/.cloudflared"
    HOME="$CF_DIR/.home" "$CF" tunnel login
    mv "$CF_DIR/.home/.cloudflared/cert.pem" "$cert"; rm -rf "$CF_DIR/.home"
    chmod 0600 "$cert"
  fi
  name="netbae-$(uname -n | cut -d. -f1 | tr '[:upper:]' '[:lower:]')"
  cfj() { "$CF" tunnel --origincert "$cert" "$@"; }
  id=$(cfj list -o json -n "$name" 2>/dev/null | "$PY" -c 'import json,sys; t=json.load(sys.stdin) or []; print(t[0]["id"] if t else "")')
  rm -f "$CF_DIR/credentials.json"  # cloudflared won't overwrite it
  if [[ -n $id ]]; then
    c_info "Using your existing tunnel '$name'"
    cfj token --cred-file "$CF_DIR/credentials.json" "$id" >/dev/null
  else
    c_info "Creating tunnel '$name'"
    cfj create --cred-file "$CF_DIR/credentials.json" "$name" >/dev/null
    id=$(cfj list -o json -n "$name" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
  fi
  secret "$CF_DIR/credentials.json"
  for h in "${hosts[@]}"; do
    if ! cfj route dns "$id" "$h" 2>/tmp/netbae-route.$$; then
      if grep -qi 'already' /tmp/netbae-route.$$ && [[ $(ask "A DNS record for $h already exists. Replace it? [y/N]" n) == [yY]* ]]; then
        cfj route dns --overwrite-dns "$id" "$h" >/dev/null
      else
        cat /tmp/netbae-route.$$ >&2; rm -f /tmp/netbae-route.$$; die "couldn't point $h at the tunnel"
      fi
    fi
  done
  rm -f /tmp/netbae-route.$$
  public_on
  # keep the hostnames shared before, so each run adds to them
  local all=() seen=" "
  for h in $(cf_hosts) "${hosts[@]}"; do
    [[ $seen == *" $h "* ]] || { all+=("$h"); seen+="$h "; }
  done
  write_cf_config "$id" "${all[@]}"
  cf_service --config "$CF_DIR/config.yml" run
  for h in "${hosts[@]}"; do wait_for_url "https://$h"; done
  if [[ ${#all[@]} -gt 1 ]]; then c_info "Shared on: ${all[*]} (stop one with: netbae tunnel remove <hostname>)"; fi
  echo "    Only invited people? Add a Cloudflare Access application for each hostname (free for up to 50 users)."
}
cf_hosts() { if [[ -f $CF_DIR/config.yml ]]; then sed -n 's/^  - hostname: *//p' "$CF_DIR/config.yml"; fi; }
write_cf_config() {  # write_cf_config <tunnel id> <hostname>...
  local id=$1 h; shift
  {
    echo "# Written by netbae tunnel. The tunnel only reaches netBae's read-only public port."
    echo "tunnel: $id"
    if [[ -n $NIX_OUT ]]; then echo "credentials-file: /run/credentials/netbae-tunnel.service/credentials.json"
    else echo "credentials-file: $CF_DIR/credentials.json"; fi
    echo "ingress:"
    for h in "$@"; do printf '  - hostname: %s\n    service: http://127.0.0.1:%s\n' "$h" "$PPORT"; done
    echo "  - service: http_status:404"
  } >"$CF_DIR/config.yml"
  chmod 0644 "$CF_DIR/config.yml"
}
cmd_remove() {
  local h=${1:-} id rest=() x
  h=${h#https://}; h=${h%%/*}
  [[ -n $h ]] || die "which hostname? e.g. netbae tunnel remove netbae.example.com"
  cf_hosts | grep -qxF "$h" || die "$h isn't shared by netbae tunnel (see: netbae tunnel status)"
  for x in $(cf_hosts); do [[ $x == "$h" ]] || rest+=("$x"); done
  [[ ${#rest[@]} -gt 0 ]] || die "$h is the only hostname; to stop sharing altogether: netbae tunnel off"
  id=$(sed -n 's/^tunnel: *//p' "$CF_DIR/config.yml")
  write_cf_config "$id" "${rest[@]}"
  if [[ $OS == Darwin ]]; then launchctl kickstart -k "system/$TLABEL"; else systemctl restart netbae-tunnel; fi
  c_info "$h no longer reaches the dashboard. Still shared on: ${rest[*]}"
  echo "    Its DNS record is still in your Cloudflare account; delete it there if you don't need it."
}

# ---------------------------------------------------------------- tailscale
find_ts() {
  command -v tailscale 2>/dev/null || ls /run/current-system/sw/bin/tailscale \
    /Applications/Tailscale.app/Contents/MacOS/Tailscale 2>/dev/null || true
}
cmd_tailscale() {
  TS=$(find_ts)
  if [[ -n $NIX_OUT ]] && ! grep -q 'tailscale = true' "$NIX_TUNNEL" 2>/dev/null; then
    c_info "Turning on Tailscale in your NixOS configuration"
    nix_tunnel keep true
    TS=/run/current-system/sw/bin/tailscale
  fi
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
  local svc_file=${UNIT:-${TPLIST:-}}
  [[ -n $NIX_OUT ]] && svc_file=$NIX_TUNNEL
  if [[ -f $svc_file ]] && { [[ -z $NIX_OUT ]] || grep -q cloudflare "$svc_file"; }; then
    local how="your own domain"
    [[ -f $CF_DIR/token ]] && grep -Eq 'token-file|tokenFile' "$svc_file" && how="a Cloudflare dashboard tunnel"
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
  remove|rm) shift; cmd_remove "$@" ;;
  status) cmd_status ;;
  off|stop) cmd_off ;;
  *.*) cmd_cloudflare "$@" ;;  # netbae tunnel netbae.example.com
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
  *) sed -n '2,14s/^# \{0,1\}//p' "$0"; exit 1 ;;
esac
