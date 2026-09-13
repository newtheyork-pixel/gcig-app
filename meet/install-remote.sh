#!/usr/bin/env bash
# Runs ON the meeting host, inside WSL. deploy.sh copies this over and
# calls it; it is kept separate so the logic is readable rather than
# buried in a quoted ssh one-liner.
set -euo pipefail
REMOTE="${MEET_REMOTE_DIR:-/home/thom/griffin-meet}"

cd "$REMOTE"
chmod +x setup.sh

[[ -f .env ]] || ./setup.sh

CFG="$(grep -E '^CONFIG=' .env | cut -d= -f2-)"
mkdir -p "$CFG/web"
# Branding is refreshed on every deploy; the rest of the config volume is
# state Jitsi owns and must survive.
rm -rf "$CFG/web/griffin" "$CFG/web/nginx-custom"
cp -r branding/griffin branding/nginx-custom "$CFG/web/"
cp branding/custom-config.js branding/custom-interface_config.js "$CFG/web/"

docker compose pull -q
docker compose up -d
sleep 5
docker compose ps
