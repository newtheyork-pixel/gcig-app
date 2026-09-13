# Griffin Fund meeting server

Self-hosted Jitsi at `meet.thegriffinfund.org`, branded in Select Equity
Group's colours, with rooms created and authorised by the Griffin API so
only members can open one.

Nothing here talks to a third party. There is no per-minute cost and no
vendor account.

## Status

Built and running. Not yet reachable from outside the host. See
**What is left** at the bottom, which is two steps, both requiring a
decision or a password that is not mine to supply.

| Piece | State |
|---|---|
| Jitsi stack, four containers | running, stable, zero restarts |
| Bridge registered with the focus component | yes |
| SEG theme, 241 tokens | serving, verified live |
| Brand marks and favicon | serving, verified as real PNG bytes |
| Room auth via Griffin-minted JWT | configured, untested end to end |
| Reachable from outside the host | **no**, see below |

## The palette

Sampled from selectequity.com rather than eyeballed. Their CSS and the
rendered page agree.

| Role | Value |
|---|---|
| Primary blue | `#00549e` |
| Light blue | `#6cace4` |
| Pale wash | `#e1ecf8` |
| Cream paper | `#f4f2ec` |
| Ink | `#3e3e3e` |

SEG's own site is blue type on cream. That is what the welcome and
prejoin screens use. It is the wrong choice behind live video, where a
light interface washes out every face and tires the eye over an hour, so
the in-call chrome is a deep navy mixed at the same hue and the blue
stays the accent. Same family, different room.

Theme lives in `branding/griffin/branding.json` and is applied through
Jitsi's `DYNAMIC_BRANDING_URL`, which feeds its design tokens directly.
Every key is checked against jitsi-meet's own `colorMap`; a key that does
not exist there is ignored silently, so validate after editing:

```bash
python3 - <<'PY'
import json; p=json.load(open('branding/griffin/branding.json'))['customTheme']['palette']
print(len(p), 'keys')
PY
```

## Bandwidth, which is the real constraint

Measured on the host, twice, with two tools that agree:

| Direction | Measured |
|---|---|
| Down | 847 Mbps |
| Up | 33 Mbps |

The gigabit plan is gigabit downstream only. A bridge spends almost
nothing on download and everything on upload, because it receives one
stream per sender and sends one copy per sender per viewer. Its cost
grows with the product of senders and viewers, not with headcount.

At the club's 39 members:

| Shape | Bridge needs | Fits |
|---|---|---|
| Audio only | ~6 Mbps | yes |
| 12 on camera | ~12 Mbps | yes |
| 20 on camera, quality capped | ~20 Mbps | yes |
| 39 on camera | 40 to 300 Mbps | no |

So this host suits advisory calls, expert calls, a pitch review, a hybrid
meeting with a few people dialling in. A full all-hands with every camera
on needs presentation mode, or a rented box with symmetric upstream. The
whole deployment is one compose file and moves in about ten minutes.

## Layout

```
docker-compose.yml      vendored from jitsi/docker-jitsi-meet, tag pinned
.env.example            every setting, with the reasoning
setup.sh                generates .env with fresh per-account secrets
deploy.sh               ships to the host and restarts
install-remote.sh       runs on the host, inside WSL
branding/               theme, marks, nginx hook, config overrides
```

## Traps already paid for

Each of these failed **silently**. Nothing logged an error.

**nginx `alias` needs `^~`, and must not have `try_files`.** Jitsi routes
rooms with `location ~ ^/([^/?&:'"]+)/(.*)$`. A regex location beats a
plain prefix no matter the order, so `location /griffin/` never ran and
every logo came back as the app's own index.html: HTTP 200, 30KB, content
type text/html. Separately, with `alias` the `$uri` in `try_files` is
still the full request path, so it never matches. Check with:

```bash
curl -sI https://meet.thegriffinfund.org/griffin/wordmark.png | grep -i content-type
# must say image/png, never text/html
```

**Prosody needs its state directory owned by uid 1000.** Otherwise it
crash-loops on `directory '/var/lib/prosody' is not writable by the
container user`, and the bridge then fails to register with a misleading
`Connection refused` against XMPP. `setup.sh` chowns it; if setup ran as
root without that, fix it by hand.

**A dynamic residential IP must not be hard-coded.** `JVB_ADVERTISE_IPS`
is deliberately empty. The STUN harvester discovers the address at
startup and survives the next DHCP lease, which a pinned address does
not. Confirmed working: the bridge found `68.175.66.192` on its own.

**WSL2 mirrored networking does not accept inbound.** See below.

## What is left

Two steps. Neither is code.

**1. Inbound to the host.** The stack answers correctly from inside the
box and from the Windows loopback, and refuses every connection from the
LAN, from Tailscale, and from the internet. This is not Docker: a plain
Python listener in WSL is equally unreachable, and a Docker published
port on a normal machine works fine. WSL2 is in mirrored networking mode,
whose Hyper-V firewall defaults to `DefaultInboundAction: Block`. Rules
scoped to the WSL VM creator id were created and are enabled, and inbound
is still refused, which usually means WSL has to restart before they
apply.

```powershell
Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore   # shows Block
Get-NetFirewallHyperVRule -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
```

Restarting WSL (`wsl --shutdown`) is the next thing to try. The LLM
router is a Windows process and is unaffected; only the containers and
the WSL-side Tailscale node stop, and both come back.

The web half can avoid this entirely by running `cloudflared` as a
container on the same Docker network pointing at `web:80`, since a tunnel
dials outward and needs no inbound at all. The media port cannot: UDP
10000 has to arrive.

**2. The media port from the internet.** Even with WSL fixed, UDP 10000
needs a forward on the router at `192.168.1.1` to `192.168.1.38`. There
is no UPnP on it, so it is a manual change. Without it, calls of three or
more people connect and then carry no audio or video; two-person calls
still work, because they go peer to peer and never touch the bridge.

## Deploying

```bash
./setup.sh     # first time only, writes .env and prints the JWT secret
./deploy.sh    # ships and restarts
```

Set the printed `JWT_APP_SECRET` on the Griffin API as
`JITSI_JWT_APP_SECRET` so the tokens it mints are accepted here.
