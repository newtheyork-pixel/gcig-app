import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { nameProfile } from '../services/nameGender.js';

// We're on cross-origin hosts (onrender.com is a public suffix, so
// gcig-client and gcig-api are "cross-site" — browsers block cross-site
// cookies by default). So tokens live in localStorage on the client and
// travel in an Authorization header. The tokenVersion claim still lets us
// invalidate every outstanding JWT instantly.
//
// Lifetime + rotation:
//   - JWTs expire 24h after issue. No token can be used for more than a
//     single day.
//   - verifyJwt silently reissues a fresh token when the current one is
//     past its half-life (12h) — the new token is returned via the
//     `X-New-Token` response header, and the client's axios interceptor
//     swaps it into localStorage. Active users never notice; inactive
//     users get a 401 after 24h and bounce to the login page.
const TOKEN_LIFETIME = '24h';
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_HALFLIFE_MS = TOKEN_LIFETIME_MS / 2;

export function issueJwt(user) {
  return jwt.sign(
    { id: user.id, role: user.role, v: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_LIFETIME }
  );
}

export async function verifyJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    // `code: 'AUTH'` marks a 401 as a verdict on the TOKEN itself (dead,
    // revoked, or absent) rather than a per-route permission answer. The
    // web client keys off it to log out + redirect on ANY endpoint, which
    // fixes the "first page loads then every data call says invalid token,
    // stuck forever" dead end. A data route's own 401 carries no code, so
    // it still bubbles up without nuking the session (the Calendar
    // fan-out case).
    return res.status(401).json({ error: 'Missing token', code: 'AUTH' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Always fetch the current role AND tokenVersion from the DB.
    // If the user rotated their tokenVersion (e.g. via logout-everywhere),
    // all old JWTs are immediately invalid.
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        extraRoles: true,
        tokenVersion: true,
      },
    });
    if (!user) return res.status(401).json({ error: 'User not found', code: 'AUTH' });
    if ((payload.v ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: 'Session revoked, please sign in again', code: 'AUTH' });
    }

    // Silent rotation — if the JWT is past its half-life, mint a fresh
    // one and expose it via X-New-Token. The client picks it up on its
    // next response and continues uninterrupted. CORS allowlist for
    // this header lives in index.js.
    if (payload.iat && Date.now() - payload.iat * 1000 > TOKEN_HALFLIFE_MS) {
      try {
        const fresh = issueJwt(user);
        res.setHeader('X-New-Token', fresh);
      } catch {
        /* ignore — failing to rotate shouldn't fail the request. */
      }
    }
    // Attach honorific / pronouns derived from the first name. Lets
    // downstream services (AI Assistant, broadcast templating, etc.)
    // personalize without re-running the name-gender lookup every time.
    const profile = nameProfile(user.name || '');
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      extraRoles: user.extraRoles || [],
      isSuperAdmin: isSuperAdminEmail(user.email),
      isGuest: isGuestEmail(user.email),
      firstName: profile.firstName,
      lastName: profile.lastName,
      honorific: profile.honorific,
      honorificName: profile.honorificName,
      pronouns: profile.pronouns,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'AUTH' });
  }
}

// Verify a raw JWT the way verifyJwt does (secret + tokenVersion) and
// return the caller's identity, or null. For the WebSocket layer, which
// cannot run Express middleware.
export async function authenticateToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, name: true, email: true, role: true, extraRoles: true, tokenVersion: true },
    });
    if (!user) return null;
    if ((payload.v ?? 0) !== (user.tokenVersion ?? 0)) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      extraRoles: user.extraRoles || [],
      isSuperAdmin: isSuperAdminEmail(user.email),
      isGuest: isGuestEmail(user.email),
    };
  } catch {
    return null;
  }
}

// Terminal access as a predicate (Analyst and above, plus Advisory, plus
// super admin), mirroring requireTerminalAccess for callers off the
// Express path.
export function hasTerminalAccess(user) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  const roles = [user.role, ...(user.extraRoles || [])];
  return roles.some((r) => {
    const advisory = r === 'AdvisoryBoardMember' || r === 'FacultyAdvisory';
    return advisory || (ROLE_RANK[r] || 0) >= ROLE_RANK.Analyst;
  });
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'President') {
    return res.status(403).json({ error: 'President role required' });
  }
  next();
}

// A sitting President OR the owner/super-admin. Used for the presidential
// step-down: the owner must be able to perform a handover even without
// holding the President role themselves. (isSuperAdmin is set in verifyJwt
// from an email match — see isSuperAdminEmail below.)
export function requirePresidentOrSuperAdmin(req, res, next) {
  if (req.user && (req.user.role === 'President' || req.user.isSuperAdmin)) {
    return next();
  }
  return res.status(403).json({ error: 'President or owner required' });
}

// Super admin = owner of the app. Identified by email match against the
// SUPER_ADMIN_EMAIL env var (comma-separated list supported for future
// flexibility). Sits above President and is the ONLY tier that can touch a
// small set of irreversible / sensitive operations. If the env var isn't set,
// no one is super admin.
export function isSuperAdminEmail(email) {
  if (!email || !process.env.SUPER_ADMIN_EMAIL) return false;
  const allowed = process.env.SUPER_ADMIN_EMAIL.split(',').map((e) =>
    e.trim().toLowerCase()
  );
  return allowed.includes(String(email).trim().toLowerCase());
}

// ---- Guest access ----------------------------------------------------
//
// A guest is an outside collaborator (not a club member) given a login
// purely to VIEW a fixed slice of research. Identified by email, so no
// schema or token change is needed. Everything about a guest is
// fail-closed: the firewall allows only an explicit set of API prefixes,
// research is scoped to GUEST_RESEARCH_TICKERS, and the club's portfolio
// and governance are invisible.
const GUEST_EMAILS = (process.env.GUEST_EMAILS || 'fb2712@columbia.edu')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isGuestEmail(email) {
  return !!email && GUEST_EMAILS.includes(String(email).trim().toLowerCase());
}

// The only research a guest may see, by ticker: the Lindt study (LISN),
// the data-center work (VRT, MTRS, ABB, SIKA, COGNITE), and UMG/GOOGL/FB.
export const GUEST_RESEARCH_TICKERS = ['LISN', 'VRT', 'MTRS', 'ABB', 'SIKA', 'COGNITE', 'UMG', 'GOOGL', 'FB'];

// API path prefixes a guest may reach; everything else is refused. Research
// is allowed HERE (the firewall lets it through) but the research routes
// scope the DATA to the whitelist on top of this. The market/macro tools
// carry no club or portfolio data.
const GUEST_API_ALLOW = [
  '/api/auth', '/api/app', '/api/2fa', '/api/public', '/api/system', '/api/health',
  '/api/research', '/api/watchlist', '/api/subscriptions',
  '/api/terminal', '/api/eco', '/api/cpi', '/api/short-interest', '/api/halts', '/api/alerts',
];

// Guest ids, resolved from GUEST_EMAILS and cached briefly. The token
// carries the id, so a non-guest request costs no DB hit at all.
let _guestIds = null;
let _guestIdsAt = 0;
async function guestUserIds() {
  if (_guestIds && Date.now() - _guestIdsAt < 60_000) return _guestIds;
  const users = await prisma.user.findMany({
    where: { email: { in: GUEST_EMAILS } },
    select: { id: true },
  });
  _guestIds = new Set(users.map((u) => u.id));
  _guestIdsAt = Date.now();
  return _guestIds;
}

// Global gate mounted on /api. Non-guests, and unauthenticated or invalid
// requests, pass straight through — the routers do their own auth. A guest
// may reach only GUEST_API_ALLOW; anything else is refused before the route
// runs. Deliberately fail-OPEN for non-guests on any error so a cache miss
// can never lock out the 36 members; the sensitive routers ALSO carry
// denyGuest, so the portfolio stays closed even in that window.
export async function guestFirewall(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  let id;
  try {
    id = jwt.verify(header.slice(7), process.env.JWT_SECRET).id;
  } catch {
    return next();
  }
  let ids;
  try {
    ids = await guestUserIds();
  } catch {
    return next();
  }
  if (!ids.has(id)) return next();
  const full = req.baseUrl + req.path; // mounted at /api -> '/api' + '/holdings/...'
  const allowed = GUEST_API_ALLOW.some((a) => full === a || full.startsWith(a + '/'));
  if (allowed) return next();
  return res.status(403).json({ error: 'Your account does not have access to this area.' });
}

// Router-level guard (defense in depth): 403 for a guest. Placed after
// verifyJwt on routers that must never serve a guest, so the portfolio
// stays closed regardless of the firewall allowlist.
export function denyGuest(req, res, next) {
  if (req.user && isGuestEmail(req.user.email)) {
    return res.status(403).json({ error: 'Your account does not have access to this.' });
  }
  next();
}

// Canonical "user" shape sent to the client in every auth response.
// Includes the isSuperAdmin flag so the UI can gate owner-only features.
//
// `honorific` / `honorificName` / `pronouns` come from a best-effort
// first-name → gender inference (see services/nameGender.js). They're
// null / neutral when the name doesn't give a confident signal, so the
// client should always fall back to the first name / they-them.
export function serializeUser(user) {
  const profile = nameProfile(user.name || '');
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSuperAdmin: isSuperAdminEmail(user.email),
    firstName: profile.firstName,
    lastName: profile.lastName,
    honorific: profile.honorific, // "Mr." / "Ms." / null
    honorificName: profile.honorificName, // "Mr. Seirer" / null
    pronouns: profile.pronouns, // { subject, object, possessive }
  };
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin required' });
  }
  next();
}

// Executive tier: President + CIO. Has admin powers for most features but
// cannot perform destructive user-account operations (delete member, reset
// password). Those remain President-only via requireAdmin.
const EXECUTIVE_ROLES = new Set(['President', 'CIO']);
export function requireExecutive(req, res, next) {
  if (!req.user || !EXECUTIVE_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: 'Executive role (President or CIO) required' });
  }
  next();
}

// Executive tier OR Advisory Board / Faculty Advisor. Used for read-only
// research tools (e.g. the Terminal) that the advisory board should be
// able to use even though they sit outside the operational chain.
const EXECUTIVE_OR_ADVISORY_ROLES = new Set([
  'President',
  'CIO',
  'AdvisoryBoardMember',
  'FacultyAdvisory',
]);
export function requireExecutiveOrAdvisory(req, res, next) {
  if (!req.user || !EXECUTIVE_OR_ADVISORY_ROLES.has(req.user.role)) {
    return res
      .status(403)
      .json({ error: 'Executive (President/CIO) or Advisory Board role required' });
  }
  next();
}

// Terminal access: Analyst and above, plus the Advisory Board.
//
// The terminal was executive-only until the FLD field-research panel
// landed, at which point the gate became actively wrong: /api/research
// is requireRole('Analyst'), so the members most likely to be making the
// calls could do the fieldwork but could not open the surface built for
// it. This mirrors that rank.
//
// JuniorAnalyst sits below Analyst in ROLE_RANK and is the default role
// for every Google self-signup, so it stays out — otherwise anyone who
// found the login page would get the whole book.
//
// Advisory members remain read-only everywhere else in the app; the
// terminal is a research surface that grants no operational power.
export function requireTerminalAccess(req, res, next) {
  const role = req.user?.role;
  const advisory = role === 'AdvisoryBoardMember' || role === 'FacultyAdvisory';
  const rank = ROLE_RANK[role] || 0;
  if (!req.user || (!advisory && rank < ROLE_RANK.Analyst)) {
    return res
      .status(403)
      .json({ error: 'Analyst role or higher (or Advisory Board) required' });
  }
  next();
}

// Operational permission hierarchy (higher number = more power).
// Advisory Board Members and Faculty Advisors sit OUTSIDE the operational chain
// — they are observers with no edit rights. Chief of Communication is a
// non-investment officer role (comms/PR) that also sits outside the analyst
// chain. All three get low ranks so permission gates treat them as view-only
// for investment-tier actions.
export const ROLE_RANK = {
  President: 10,
  CIO: 9,
  SeniorPortfolioManager: 8,
  PortfolioManager: 7,
  SeniorAnalyst: 6,
  Analyst: 5,
  JuniorAnalyst: 4,
  ChiefOfCommunication: 2,
  AdvisoryBoardMember: 1,
  FacultyAdvisory: 1,
  // Honorific badge only — confers no power. A former president's primary
  // role is JuniorAnalyst; this rank only matters as defense in depth if
  // FormerPresident were ever mis-set as a primary role.
  FormerPresident: 0,
};

// Look up the role string for a given numeric rank. Returns null if no match.
export function roleForRank(rank) {
  for (const [role, r] of Object.entries(ROLE_RANK)) {
    if (r === rank) return role;
  }
  return null;
}

export function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole] || 0;
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role] || 0;
    if (rank < minRank) {
      return res.status(403).json({ error: `${minRole} role or higher required` });
    }
    next();
  };
}
