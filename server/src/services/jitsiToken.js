import jwt from 'jsonwebtoken';

// Tokens for the club's own meeting server at meet.thegriffinfund.org.
//
// The meeting server runs with authentication on and guests allowed. That
// pair is the whole access model, and it is worth stating plainly because
// it is easy to get backwards:
//
//   a MEMBER holds a token, and a token is the only way to OPEN a room
//   anyone else may JOIN a room that is already open, with no token at all
//
// So a link is safe to forward to an outside expert, and useless to
// someone who finds it before the meeting starts. Nobody can create a room
// on our server by guessing a name, which is what stops the address being
// an open conferencing service for the internet.
//
// The secret is shared with Prosody. It is NOT the API's own JWT_SECRET:
// signing Jitsi tokens with the session secret would mean a leak of either
// one compromised both.

const APP_ID = process.env.JITSI_JWT_APP_ID || 'griffin';
// The XMPP domain the meeting server calls itself internally. Prosody
// checks this against the token's `sub`, and it is deliberately not the
// public hostname.
const XMPP_DOMAIN = process.env.JITSI_XMPP_DOMAIN || 'meet.jitsi';

export function isConfigured() {
  return Boolean(process.env.JITSI_JWT_APP_SECRET);
}

// Four hours. Long enough that a token minted for a scheduled meeting is
// still valid when someone joins late, short enough that one copied out of
// a browser is not a permanent key to the room.
const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

export function mintJitsiToken({
  room,
  user,
  moderator = false,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now(),
} = {}) {
  const secret = process.env.JITSI_JWT_APP_SECRET;
  if (!secret) throw new Error('JITSI_JWT_APP_SECRET is not set');
  if (!room || typeof room !== 'string') throw new Error('room is required');
  if (!user || !user.id) throw new Error('user is required');

  const iat = Math.floor(now / 1000);

  return jwt.sign(
    {
      aud: APP_ID,
      iss: APP_ID,
      sub: XMPP_DOMAIN,
      // Scoped to ONE room. A token minted with '*' would open every
      // meeting on the server, including ones the holder was never in.
      room,
      iat,
      // Backdated by a minute so a client whose clock runs slightly fast
      // is not refused by Prosody's nbf check.
      nbf: iat - 60,
      exp: iat + ttlSeconds,
      context: {
        user: {
          id: String(user.id),
          name: user.name || 'Griffin member',
          email: user.email || undefined,
          // Prosody reads this as a STRING, not a boolean. A real boolean
          // here is read as absent and the holder silently joins as an
          // ordinary participant who cannot open the room.
          moderator: moderator ? 'true' : 'false',
        },
      },
    },
    secret,
    { algorithm: 'HS256' },
  );
}

// Exported for the tests and for any future admin tooling that needs to
// read a token back without reaching for the library directly.
export function verifyJitsiToken(token) {
  const secret = process.env.JITSI_JWT_APP_SECRET;
  if (!secret) throw new Error('JITSI_JWT_APP_SECRET is not set');
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    audience: APP_ID,
    issuer: APP_ID,
  });
}

// The URL a member actually opens.
//
// The token rides in the query string because that is what Jitsi reads.
// Everything after the # is client-side config the server never sees, which
// is where the human-readable title goes: without it Jitsi displays the
// room CODE, and having already watched it render "griffin-q3-review" as
// "Griffin Q 3 Review", the code is not what anyone should be shown.
export function meetingUrl({ code, token, title, base } = {}) {
  const origin = (base || process.env.MEET_BASE_URL || 'https://meet.thegriffinfund.org')
    .replace(/\/+$/, '');
  const url = new URL(`${origin}/${encodeURIComponent(code)}`);
  if (token) url.searchParams.set('jwt', token);
  const hash = [];
  if (title) hash.push(`config.subject=${encodeURIComponent(JSON.stringify(title))}`);

  // A member arriving WITH a token has already proved who they are, and the
  // token carries their name. Making them stop at a prejoin screen to type
  // it again is asking a question we know the answer to, so that screen is
  // switched off for them and they land straight in the room.
  //
  // It stays on for everyone else. A guest following a forwarded link has no
  // token and no name, and the prejoin screen is the only place they can say
  // who they are before walking into a meeting.
  if (token) {
    hash.push('config.prejoinConfig.enabled=false');
    hash.push('config.requireDisplayName=false');
  }

  return hash.length ? `${url.toString()}#${hash.join('&')}` : url.toString();
}
