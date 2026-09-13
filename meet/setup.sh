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

# Secrets are generated in python, deliberately.
#
# The shell version of this was `tr -dc ... < /dev/urandom | head -c 40`, and
# it silently destroyed the whole deployment's security. head exits after 40
# bytes, tr takes SIGPIPE, pipefail turns that into a failed pipeline, and
# set -e aborted the script one line after it had copied .env.example into
# place. Result: every password and the JWT signing secret stayed as the
# literal string __GENERATE__, the stack came up perfectly, and nothing
# anywhere reported a problem. A known signing secret means anyone can mint
# themselves a moderator token.
#
# re.sub with a function is called once per match, so each placeholder gets
# its OWN secret rather than all of them sharing one.
python3 - <<'PYGEN'
import re, secrets, string
alphabet = string.ascii_letters + string.digits
src = open('.env').read()
out, n = re.subn(r'__GENERATE__',
                 lambda m: ''.join(secrets.choice(alphabet) for _ in range(40)),
                 src)
open('.env', 'w').write(out)
print(f"  generated {n} secrets")
if re.search(r'__GENERATE__', out):
    raise SystemExit("placeholder survived generation")
PYGEN

# Fail loudly rather than ship a known secret.
if grep -q '__GENERATE__' .env; then
    echo "FATAL: secrets were not generated; refusing to continue" >&2
    exit 1
fi

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
