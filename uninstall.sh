#!/usr/bin/env bash
# Removes netBae. Pass --purge to also delete the config, database and service user.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then exec sudo bash "$0" "$@"; fi

systemctl disable --now netbae 2>/dev/null || true
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
