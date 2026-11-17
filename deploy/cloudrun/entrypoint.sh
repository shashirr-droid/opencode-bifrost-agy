#!/bin/sh
set -eu

mkdir -p /tmp/bifrost-data
umask 077
sed \
  -e "s|__VK_OPENCODE_DEFAULT__|${VK_OPENCODE_DEFAULT}|g" \
  -e "s|__VK_OPENCODE_AGY__|${VK_OPENCODE_AGY}|g" \
  /app/config.template.json > /tmp/bifrost-data/config.json

exec /usr/local/bin/bifrost-http \
  -app-dir /tmp/bifrost-data \
  -host 0.0.0.0 \
  -port "${PORT:-8080}" \
  -log-level info \
  -log-style json
