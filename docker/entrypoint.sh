#!/bin/sh
# Creates /data/config.toml on first start (from the shipped defaults), then runs netBae.
#   NETBAE_PORT  web port for a new config (default 80)
#   /host        mount the host's root read-only here to show the host's disk usage
set -e
CONF="${NETBAE_CONFIG:-/data/config.toml}"
mkdir -p "$(dirname "$CONF")"

if [ ! -f "$CONF" ]; then
  echo "netBae: creating $CONF from the defaults"
  sed -e 's|^database = .*|database = "/data/netbae.db"|' \
      -e "s|^port = 80 .*|port = ${NETBAE_PORT:-80}|" \
      /opt/netbae/config.default.toml > "$CONF"
  if [ -d /host ]; then
    sed -i 's|^disk_path = .*|disk_path = "/host"        # the host'"'"'s root, mounted read-only|' "$CONF"
  fi
fi
cp /opt/netbae/config.default.toml "$(dirname "$CONF")/config.toml.default"

exec python3 /opt/netbae/netbae.py -c "$CONF" "$@"
