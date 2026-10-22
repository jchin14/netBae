#!/usr/bin/env bash
# netbae - manage netBae on NixOS (the same commands as on other systems). Part of the Nix package.
set -euo pipefail

SERVER=@server@
VERSION=@version@
NIXOS_FILE=/etc/nixos/netbae.nix   # written by install.sh on NixOS ("installer-managed")
SRC=/etc/nixos/netbae              # netBae's source, imported by that file
MARK="Added by the netBae installer"

as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }
installed_by_script() { [[ -f $NIXOS_FILE ]] && grep -q "$MARK" "$NIXOS_FILE"; }
repo() { cat "$SRC/REPO" 2>/dev/null || echo jchin14/netBae; }
# the config file the running service uses (-c in its ExecStart)
config_path() {
  local exec
  exec=$(systemctl show netbae -p ExecStart --value 2>/dev/null || true)
  [[ $exec =~ -c\ ([^ ;]+) ]] && echo "${BASH_REMATCH[1]}" || echo /etc/netbae/config.toml
}
rebuild() {
  if [[ -f /etc/nixos/flake.nix ]] && [[ -d /etc/nixos/.git ]]; then
    as_root git -C /etc/nixos add -A netbae.nix netbae 2>/dev/null || true  # flakes only see files git knows
  fi
  as_root nixos-rebuild switch
}

case "${1:-help}" in
  status)  systemctl status netbae --no-pager ;;
  logs)    journalctl -u netbae -f ;;
  restart) as_root systemctl restart netbae && echo "restarted" ;;
  start)   as_root systemctl start netbae ;;
  stop)    as_root systemctl stop netbae ;;
  version) echo "netBae $VERSION (Nix)" ;;
  check)   as_root "$SERVER" -c "$(config_path)" --check-config ;;
  config)
    conf=$(config_path)
    if [[ $conf == /nix/store/* ]]; then
      echo "This netBae's config is generated from services.netbae.settings in your NixOS configuration:"
      echo "change it there, then run: sudo nixos-rebuild switch"
      exit 0
    fi
    as_root "${EDITOR:-nano}" "$conf"
    if as_root "$SERVER" -c "$conf" --check-config >/dev/null; then
      as_root systemctl restart netbae && echo "config OK - netBae restarted"
    else
      echo "config has errors - not restarted" >&2; exit 1
    fi
    ;;
  update|upgrade)
    if installed_by_script; then
      latest=$(curl -fsSL "https://raw.githubusercontent.com/$(repo)/main/app/netbae.py" 2>/dev/null \
               | sed -n 's/^VERSION = "\(.*\)"/\1/p' || true)
      if [[ -n $latest && $VERSION != "$latest" \
            && $(printf '%s\n%s\n' "$VERSION" "$latest" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1) == "$VERSION" ]]; then
        echo "netBae $VERSION is newer than the latest release ($latest): nothing to update."; exit 0
      fi
      echo "Installed: netBae $VERSION. Fetching the latest from github.com/$(repo) …"
      curl -fsSL "https://raw.githubusercontent.com/$(repo)/main/install.sh" | as_root env NETBAE_REPO="$(repo)" bash
    elif [[ -f /etc/nixos/flake.nix ]] && grep -q netbae /etc/nixos/flake.nix; then
      as_root nix --extra-experimental-features 'nix-command flakes' flake update netbae --flake /etc/nixos
      as_root nixos-rebuild switch
    else
      echo "Update netBae where your NixOS configuration gets it (e.g. nix flake update netbae), then: sudo nixos-rebuild switch"
    fi
    ;;
  uninstall)
    if ! installed_by_script; then
      echo "netBae comes from your NixOS configuration: remove services.netbae (and the netbae flake input) there,"
      echo "then run: sudo nixos-rebuild switch"
      [[ ${2:-} == --purge ]] && echo "Then delete its history with: sudo rm -rf /var/lib/private/netbae /etc/netbae"
      exit 0
    fi
    conf=/etc/nixos/configuration.nix
    if grep -q './netbae.nix' "$conf" 2>/dev/null; then
      as_root cp "$conf" "$conf.netbae-backup"
      as_root sed -i -e 's# \./netbae\.nix##' -e '/^ *imports = \[ *\]; *$/d' "$conf"
    fi
    as_root rm -rf "$NIXOS_FILE" "$SRC"
    if [[ -d /etc/nixos/.git ]]; then as_root git -C /etc/nixos add -A netbae.nix netbae configuration.nix 2>/dev/null || true; fi
    as_root nixos-rebuild switch
    echo "netBae removed. Ookla's speedtest CLI went with it."
    if [[ ${2:-} == --purge ]]; then
      as_root rm -rf /etc/netbae /var/lib/private/netbae /var/lib/netbae
      echo "Config (/etc/netbae) and data (/var/lib/private/netbae) were deleted."
    else
      echo "Config (/etc/netbae) and data (/var/lib/private/netbae) kept. Re-run with --purge to delete them."
    fi
    ;;
  tunnel)
    echo "netbae tunnel isn't available on NixOS yet. To share the public dashboard, use NixOS's own"
    echo "services.cloudflared or services.tailscale (see \"Sharing a public dashboard\" in the README)."
    exit 1
    ;;
  *)
    cat <<HELP
netbae - manage the netBae internet monitor (NixOS)

  netbae update       update to the latest version (keeps config + data)
  netbae status       service status
  netbae logs         follow the log
  netbae config       edit the config, validate it and restart
  netbae check        validate the config and show the next speedtest times
  netbae restart | start | stop
  netbae version
  netbae uninstall [--purge]
HELP
    ;;
esac
