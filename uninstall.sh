#!/usr/bin/env bash
# Removes netBae. Pass --purge to also delete the config, database and service user.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then exec sudo bash "$0" "$@"; fi

# netbae tunnel: turn off a Tailscale Funnel that points at netBae's public port
TS=$(command -v tailscale || ls /Applications/Tailscale.app/Contents/MacOS/Tailscale 2>/dev/null || true)
CONF_FILE=/etc/netbae/config.toml; [[ $(uname -s) == Darwin ]] && CONF_FILE=/usr/local/etc/netbae/config.toml
PPORT=$(sed -n '/^\[public\]/,/^\[/s/^port *= *\([0-9]*\).*/\1/p' "$CONF_FILE" 2>/dev/null | head -1)
if [[ -n $TS ]] && "$TS" funnel status 2>/dev/null | grep -q "127.0.0.1:${PPORT:-8080}"; then
  "$TS" funnel --https=443 off >/dev/null 2>&1 || true
fi

if [[ $(uname -s) == Darwin ]]; then
  LABEL=com.github.netbae
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  launchctl bootout "system/$LABEL.tunnel" 2>/dev/null || true  # netbae tunnel (Cloudflare)
  rm -f "/Library/LaunchDaemons/$LABEL.tunnel.plist"
  pkill -f /usr/local/lib/netbae/netbae.py 2>/dev/null || true  # also any copy started by hand
  rm -f "/Library/LaunchDaemons/$LABEL.plist" /etc/newsyslog.d/netbae.conf
  rm -rf /usr/local/lib/netbae
  rm -f /usr/local/bin/netbae
  echo "netBae removed. The Ookla speedtest CLI was left installed (brew uninstall speedtest to remove it)."
  if [[ "${1:-}" == "--purge" ]]; then
    rm -rf /usr/local/etc/netbae /usr/local/var/netbae
    rm -f /usr/local/var/log/netbae.log* /usr/local/var/log/netbae-tunnel.log
    dscl . -delete /Users/_netbae 2>/dev/null || true
    dscl . -delete /Groups/_netbae 2>/dev/null || true
    echo "Config, data, log and the _netbae user were deleted."
  else
    echo "Config (/usr/local/etc/netbae) and data (/usr/local/var/netbae) kept. Re-run with --purge to delete them."
  fi
  exit 0
fi

systemctl disable --now netbae 2>/dev/null || true
systemctl disable --now netbae-tunnel 2>/dev/null || true  # netbae tunnel (Cloudflare)
rm -f /etc/systemd/system/netbae-tunnel.service
pkill -f /opt/netbae/netbae.py 2>/dev/null || true  # also any copy started by hand
rm -f /etc/systemd/system/netbae.service
systemctl daemon-reload
rm -rf /opt/netbae
rm -f /usr/local/bin/netbae
echo "netBae removed. The Ookla speedtest CLI was left installed."

if [[ "${1:-}" == "--purge" ]]; then
  rm -rf /etc/netbae /var/lib/netbae
  userdel netbae 2>/dev/null || true
  echo "Config, data and the netbae user were deleted."
else
  echo "Config (/etc/netbae) and data (/var/lib/netbae) kept. Re-run with --purge to delete them."
fi
