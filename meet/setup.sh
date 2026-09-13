#!/usr/bin/env bash
# Generates .env from .env.example with fresh secrets, and lays out the
# config volume Jitsi expects. Safe to re-run: it refuses to clobber an
# existing .env, because regenerating secrets would lock every running
# container out of Prosody at once.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
    echo "refusing to overwrite the existing .env"
    echo "delete it first if you really mean to rotate every secret"
    exit 1
fi

gen() { LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 40; }

cp .env.example .env
# Each __GENERATE__ gets its OWN secret. A single sed with one value would
# hand Prosody the same password for five different accounts.
while grep -q '__GENERATE__' .env; do
    secret="$(gen)"
    # Replace only the first remaining placeholder, then loop.
    awk -v s="$secret" 'BEGIN{done=0} {if(!done && index($0,"__GENERATE__")){sub(/__GENERATE__/,s); done=1} print}' .env > .env.tmp
    mv .env.tmp .env
done
chmod 600 .env

CONFIG="$(grep -E '^CONFIG=' .env | cut -d= -f2-)"
mkdir -p "$CONFIG"/{web,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb}
mkdir -p "$CONFIG"/storage/{web,transcripts,prosody}
mkdir -p "$CONFIG"/tmp/web-load-test

# Branding is copied in rather than symlinked: the web container gets the
# config volume as a bind mount and will not follow a link out of it.
cp -r branding/custom-config.js branding/custom-interface_config.js "$CONFIG/web/"
rm -rf "$CONFIG/web/griffin" "$CONFIG/web/nginx-custom"
cp -r branding/griffin branding/nginx-custom "$CONFIG/web/"

# The Jitsi images run as uid 1000 and Prosody refuses to start if its
# state directory is not writable by that user. If setup runs as root the
# directories land root-owned and prosody crash-loops with
# "directory '/var/lib/prosody' is not writable by the container user".
chown -R 1000:1000 "$CONFIG" 2>/dev/null || \
  echo "note: could not chown $CONFIG to 1000:1000; run this as root if prosody fails to start"

echo "wrote .env and laid out $CONFIG"
echo
echo "Set this on the Griffin API as JITSI_JWT_APP_SECRET so it can mint"
echo "tokens this server will accept:"
echo
grep -E '^JWT_APP_SECRET=' .env | cut -d= -f2-
