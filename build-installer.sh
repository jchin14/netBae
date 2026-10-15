#!/usr/bin/env bash
# Bundles the whole project into one self-extracting file: dist/netbae-installer.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/dist/netbae-installer.sh"
mkdir -p "$DIR/dist"

TAR_OPTS=(--exclude='__pycache__' --exclude='.DS_Store' --exclude='static/vendor')
[[ "$(uname)" == Darwin ]] && TAR_OPTS+=(--no-mac-metadata)

{
  cat <<'EOF'
#!/usr/bin/env bash
# netBae self-extracting installer. Usage: sudo bash netbae-installer.sh
set -euo pipefail
if [[ $EUID -ne 0 ]]; then exec sudo bash "$0" "$@"; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sed '1,/^__PAYLOAD_BELOW__$/d' "$0" | base64 -d | tar -xzf - -C "$TMP"
bash "$TMP/install.sh" "$@"
exit 0
__PAYLOAD_BELOW__
EOF
  COPYFILE_DISABLE=1 tar -czf - "${TAR_OPTS[@]}" -C "$DIR" install.sh uninstall.sh config.toml app | base64
} >"$OUT"
chmod +x "$OUT"
echo "Built $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
