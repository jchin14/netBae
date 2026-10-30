#!/usr/bin/env bash
# Bundles the installer and app into one download: dist/netbae-<version>.tar.gz, a plain archive holding a
# netbae-<version>/ folder. Install from it with:
#   tar -xzf netbae-<version>.tar.gz && cd netbae-<version> && sudo bash install.sh
# (Not a self-extracting script: one that decodes a hidden payload and runs it as root looks like a dropper
# to antivirus machine learning, which flagged it as a trojan even though the files inside scanned clean.)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$DIR/app/netbae.py")
NAME="netbae-$VERSION"
OUT="$DIR/dist/$NAME.tar.gz"
mkdir -p "$DIR/dist"
rm -f "$DIR"/dist/netbae-*.tar.gz "$DIR/dist/netbae-installer.sh"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/$NAME"
(cd "$DIR" && tar -cf - --exclude='__pycache__' --exclude='.DS_Store' --exclude='static/vendor' \
  install.sh uninstall.sh tunnel.sh config.toml LICENSE app bin nix) | tar -xf - -C "$STAGE/$NAME"

# files owned by root in the archive, not by whoever built it
# and without macOS extended attributes (quarantine, provenance), which Linux tar warns about one by one
if [[ "$(uname)" == Darwin ]]; then TAR_OPTS=(--no-mac-metadata --no-xattrs --no-acls --uid 0 --gid 0); else TAR_OPTS=(--owner=0 --group=0); fi
COPYFILE_DISABLE=1 tar -czf "$OUT" "${TAR_OPTS[@]}" -C "$STAGE" "$NAME"
echo "Built $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
