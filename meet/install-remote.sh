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

# The web image does `cp -r /config/. /run/web/config` ONCE at container
# start, and nginx serves that copy. So editing the config volume changes
# nothing until the container restarts: the old theme keeps being served,
# with a 200 and the right content type, and the only clue is a byte count
# that does not match the file on disk. Always recreate web after touching
# branding.
docker compose up -d --force-recreate web
sleep 8

CFG_JSON="$CFG/web/griffin/branding.json"
IP=$(docker inspect griffin-meet-web-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
ON_DISK=$(stat -c%s "$CFG_JSON")
SERVED=$(curl -s --max-time 10 "http://$IP:8000/griffin/branding.json" | wc -c)
if [ "$ON_DISK" = "$SERVED" ]; then
    echo "branding served matches disk ($SERVED bytes)"
else
    echo "WARNING: serving $SERVED bytes but disk has $ON_DISK; the web container is stale" >&2
fi

docker compose ps
