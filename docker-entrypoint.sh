#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID:$PGID" in
  *[!0-9:]*|:*|0:*|*:0) echo "PUID and PGID must be non-zero numeric values" >&2; exit 1 ;;
esac

if [ ! -e /config ]; then
  mkdir -p /config
fi

# Only the Portall state volume is adjusted. Mounted service data, including a
# read-only Tautulli database, is deliberately never traversed or modified.
if [ -w /config ]; then
  chown -R "$PUID:$PGID" /config
else
  echo "Warning: /config is read-only; ownership was not changed" >&2
fi

exec gosu "$PUID:$PGID" "$@"
