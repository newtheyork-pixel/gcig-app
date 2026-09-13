#!/usr/bin/env bash
# Ships this directory to the meeting host and restarts the stack.
#
# The host runs Windows with the Linux side in WSL2 under mirrored
# networking, which is why the bridge can bind the machine's real LAN
# address and UDP reaches it at all. Everything below runs inside WSL.
#
# Two rules learned the hard way about this path:
#   - a tarball, not recursive scp, because cmd.exe mangles slashes
#   - run the installer BY PATH, never as an inline `bash -c '...'`,
#     because the quoting has to survive ssh, then cmd, then wsl, then
#     bash, and it does not
set -euo pipefail
cd "$(dirname "$0")"

HOST="${MEET_HOST:-thoma@100.82.48.3}"
DISTRO="${MEET_WSL_DISTRO:-Ubuntu-22.04}"
REMOTE="${MEET_REMOTE_DIR:-/home/thom/griffin-meet}"
WINDIR='C:/Users/thoma'

echo "==> packing"
tar czf /tmp/griffin-meet.tgz \
    docker-compose.yml docker-compose.override.yml .env.example setup.sh install-remote.sh branding \
    $( [[ -f .env ]] && echo .env )

echo "==> copying to $HOST"
scp -q /tmp/griffin-meet.tgz "$HOST:$WINDIR/griffin-meet.tgz"

# The bootstrap is generated here so REMOTE stays configurable from one place.
cat > /tmp/griffin-meet-boot.sh <<BOOT
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$REMOTE"
tar xzf /mnt/c/Users/thoma/griffin-meet.tgz -C "$REMOTE"
chmod +x "$REMOTE/install-remote.sh" "$REMOTE/setup.sh"
MEET_REMOTE_DIR="$REMOTE" "$REMOTE/install-remote.sh"
BOOT
scp -q /tmp/griffin-meet-boot.sh "$HOST:$WINDIR/griffin-meet-boot.sh"

echo "==> installing into $REMOTE"
ssh "$HOST" "wsl -d $DISTRO -- bash /mnt/c/Users/thoma/griffin-meet-boot.sh"
echo "==> done"
