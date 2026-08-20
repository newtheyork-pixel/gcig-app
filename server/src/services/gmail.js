import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Sending outreach as the member who wrote it, and reading back what
// comes in, so nobody has to log a reply by hand.
//
// The reply loop is the point. Sending is the easy half and on its own it
// makes things worse: the outbound record becomes automatic and precise
// while the inbound record stays a thing somebody remembers to do, and the
// gap between them is already why a contact's progress can be expressed
// four ways that disagree. Ten of Kanter's messages once went in with no
// draft attached and rendered nowhere.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// We only ever read threads we started. The token Google gives us can read
// the whole mailbox; the code never asks it to. Every fetch is keyed on a
// gmailThreadId we recorded when WE sent something, so a member's personal
// mail is not merely unshown, it is never requested. That is a real
// difference and the reason readonly is defensible at all.
//
// Nothing sends that has not been screened. The gate lives at the send
// call rather than in the button, because a gate in the UI is a gate that
// the next client forgets.

const SCOPES = [
  // Send only. NOT gmail.compose, which can also create and delete drafts
  // in the member's mailbox, and not gmail.modify, which can delete mail.
  'https://www.googleapis.com/auth/gmail.send',
  // Read only, self-limited to our own threads as above.
  'https://www.googleapis.com/auth/gmail.readonly',
  // So we can see WHICH mailbox was connected and refuse one this member
  // may not bind. See mayBind below; the check is real, not aspirational.
  'https://www.googleapis.com/auth/userinfo.email',
];

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Who may connect a mailbox at all.
 *
 * Deliberately NOT a role. Sending real email from a real inbox, and
 * reading what comes back, is not something that should arrive with a
 * promotion: an Analyst gaining terminal access should not also silently
 * gain the ability to send mail as the club. It is a named list of people,
 * and today that list is two.
 *
 * FAILS CLOSED. An unset GMAIL_SENDERS means nobody may connect, not
 * everybody. The opposite default is how a config that never got set on a
 * new environment quietly opens the feature to the whole club.
 */
export function gmailSenders() {
  return (process.env.GMAIL_SENDERS || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export function maySendMail(user) {
  const email = String(user?.email || '').toLowerCase();
  return Boolean(email) && gmailSenders().includes(email);
}

export function gmailConfigured() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function redirectUri() {
  const base = process.env.API_PUBLIC_URL || 'https://gcig-api.onrender.com';
  return `${base.replace(/\/+$/, '')}/api/gmail/callback`;
}

function client() {
  if (!gmailConfigured()) throw new Error('Gmail is not configured on this server');
  return new OAuth2Client(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri()
  );
}

/**
 * The consent URL.
 *
 * `prompt: 'consent'` is not belt and braces. Google returns a refresh
 * token only on the FIRST consent for a given client and account, so a
 * member who has connected before, been disconnected, and reconnects gets
 * an access token and no refresh token, and the connection dies quietly
 * fifty minutes later. Forcing the consent screen every time is the cost
 * of a connection that survives.
 */
export function consentUrl(state) {
  return client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/**
 * Which mailboxes an account is allowed to bind.
 *
 * The member's own login address always, plus the club domain, plus any
 * explicit extras. This is checked because the alternative is the hole this
 * function shipped with: `state` proves who MINTED a consent URL, never who
 * is sitting at the browser that opens it. A member could hand their own
 * consent link to somebody else, and whatever mailbox that person connected
 * bound to the first member's account, handing them a send-as-anyone
 * primitive over a real Gmail.
 */
async function mayBind(userId, address) {
  const a = String(address || '').toLowerCase();
  const domain = a.split('@')[1] || '';
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  // The account doing the binding must itself be a permitted sender. This
  // repeats the route gate on purpose: the callback is reached by a browser
  // redirect rather than by a client we control, so it is the one door that
  // must be able to refuse on its own.
  if (!maySendMail(u)) return false;
  if (a && a === String(u?.email || '').toLowerCase()) return true;
  const extra = (process.env.GMAIL_ALLOWED_ADDRESSES || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(a)) return true;
  const domains = (process.env.GMAIL_ALLOWED_DOMAINS || 'thegriffinfund.org')
    .split(',').map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  return domains.includes(domain);
}

export async function exchangeCode(code, userId) {
  const c = client();
  const { tokens } = await c.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Disconnect the app at myaccount.google.com and try again.');
  }
  c.setCredentials(tokens);
  const info = await c.request({ url: 'https://www.googleapis.com/oauth2/v2/userinfo' });
  const address = info?.data?.email;
  if (!address) throw new Error('Could not read which mailbox was connected');

  if (!(await mayBind(userId, address))) {
    throw new Error(`${address} is not a mailbox this account may connect. `
      + 'Sign in to Google as yourself, or ask an exec to add the address.');
  }
  // One mailbox, one member. Without this, two accounts can hold live
  // credentials to the same inbox and neither disconnect removes the other.
  const claimed = await prisma.gmailAccount.findFirst({
    where: { address, NOT: { userId } },
    select: { userId: true },
  });
  if (claimed) throw new Error(`${address} is already connected to another member's account.`);

  const row = {
    address,
    accessToken: tokens.access_token || null,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    scope: tokens.scope || null,
    revokedAt: null,
  };
  await prisma.gmailAccount.upsert({
    where: { userId },
    update: row,
    create: { userId, ...row },
  });
  return address;
}

/**
 * An authorised client for one member, refreshed if needed.
 *
 * A refresh that Google refuses is recorded rather than thrown away.
 * A connection that has gone bad and still looks connected is how a send
 * fails silently and a chase clock keeps counting against an email that
 * was never delivered.
 */
async function clientFor(userId) {
  const acct = await prisma.gmailAccount.findUnique({ where: { userId } });
  if (!acct) throw new Error('This account has no Gmail connected');
  if (acct.revokedAt) throw new Error('The Gmail connection was refused. Reconnect it.');

  const c = client();
  c.setCredentials({
    refresh_token: acct.refreshToken,
    access_token: acct.accessToken || undefined,
    expiry_date: acct.expiresAt ? acct.expiresAt.getTime() : undefined,
  });

  const fresh = acct.expiresAt && acct.expiresAt.getTime() - Date.now() > 60_000;
  if (!fresh) {
    try {
      const { credentials } = await c.refreshAccessToken();
      await prisma.gmailAccount.update({
        where: { userId },
        data: {
          accessToken: credentials.access_token || null,
          expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
        },
      });
    } catch (err) {
      await prisma.gmailAccount.update({ where: { userId }, data: { revokedAt: new Date() } });
      throw new Error('Google refused the saved Gmail credentials. Reconnect Gmail.');
    }
  }
  return { c, acct };
}

async function call(c, path, init = {}) {
  const res = await c.request({
    url: `${API}${path}`,
    method: init.method || 'GET',
    data: init.body,
    headers: init.headers,
  });
  return res.data;
}

/**
 * RFC 2822, base64url, which is what Gmail's send endpoint takes.
 *
 * The header set is deliberate. `To` is one address because outreach is
 * one person at a time and a Bcc list is a mail merge that looks like one.
 * `In-Reply-To` and `References` are what make a chase land inside the
 * existing conversation rather than starting a second one in the
 * recipient's inbox, which is the single rudest thing an automated sender
 * does.
 */
/**
 * A display name, quoted the way RFC 5322 wants it.
 *
 * Without one the recipient's client shows the local part of the address,
 * so a message from tcs@thegriffinfund.org arrives from "tcs". A cold
 * email whose sender reads as three lowercase letters looks automated
 * before the subject line gets a chance.
 *
 * Always quoted rather than quoted-when-necessary: a bare display name
 * containing a comma, a full stop or a colon is a malformed header, and
 * "Seirer, Thomas" is exactly the shape somebody eventually types.
 */
function displayFrom(name, address) {
  const addr = String(address).replace(/[\r\n]/g, '').trim();
  const n = String(name || '').replace(/[\r\n]/g, ' ').trim();
  if (!n) return addr;
  return `"${n.replace(/["\\]/g, '')}" <${addr}>`;
}

/**
 * Who else sees it.
 *
 * Every outreach email copies the club's other officer, which is not a
 * courtesy: two people run this, a reply can land while one of them is in
 * class, and a thread only one person can see is a thread that stalls for
 * a day nobody notices. It also means the record is not one member's word
 * about what was said.
 *
 * The sender is never copied on their own mail. Gmail already files it in
 * Sent, and a copy addressed to yourself is a second inbox entry for a
 * conversation you started.
 */
export function outreachCc(fromAddress) {
  const from = String(fromAddress || '').toLowerCase();
  return (process.env.OUTREACH_CC || '')
    .split(',').map((x) => x.trim()).filter(Boolean)
    .filter((a) => a.toLowerCase() !== from);
}

/**
 * Everyone who should still be on the conversation.
 *
 * Reply-all, done carefully. The standing club CC, plus whoever was already
 * addressed on the message being answered, minus ourselves and minus the
 * person already in the To line. Answering only the sender silently evicts
 * anybody they had brought in, which reads to them as being cut out.
 *
 * Deduplicated case-insensitively on the bare address, because the same
 * person appears as `Jane Doe <j@x.com>` in one header and `j@x.com` in the
 * next, and sending to both is its own kind of rude.
 */
export function mergeCc(standing, extra, selfAddress, toAddress) {
  const bare = (v) => {
    const m = String(v).match(/<([^>]+)>/);
    return (m ? m[1] : String(v)).trim().toLowerCase();
  };
  const drop = new Set([
    String(selfAddress || '').toLowerCase(),
    bare(toAddress || ''),
  ].filter(Boolean));
  const out = []; const seen = new Set();
  for (const v of [...(standing || []), ...(extra || [])]) {
    const addr = bare(v);
    if (!addr || !addr.includes('@') || drop.has(addr) || seen.has(addr)) continue;
    seen.add(addr); out.push(String(v).trim());
  }
  return out;
}

/**
 * One letter, in both dialects a mail client might read.
 *
 * This used to send bare text/plain and let every client invent its own
 * paragraph handling, which is not a formatting preference so much as a
 * refusal to decide. Outlook strips what it calls extra line breaks from
 * plain text BY DEFAULT, and a third of the addresses in the Signet
 * campaign are on Microsoft, so a letter written in six paragraphs could
 * arrive as one undifferentiated block with no way for us to know.
 *
 * So the paragraphs are now stated in a language that cannot be
 * reinterpreted. text/plain stays first for anyone who prefers it, and
 * an HTML alternative carries the same words with the breaks made
 * structural. Blank line means new paragraph; a single newline inside a
 * block (the four signature lines) stays a line break.
 *
 * Both parts are base64'd rather than sent raw, which sidesteps the 998
 * octet line limit in RFC 5322 that our 260-character paragraphs sit
 * uncomfortably close to, and headers carrying anything outside ASCII
 * are RFC 2047 encoded rather than emitted as raw UTF-8 on a header line.
 */
function encodeHeader(v) {
  const str = String(v).replace(/[\r\n]/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

/** An address header keeps its angle brackets out of the encoded word. */
function encodeAddress(v) {
  const str = String(v).replace(/[\r\n]/g, ' ').trim();
  const m = str.match(/^(.*?)\s*(<[^>]+>)$/);
  if (!m) return encodeHeader(str);
  const name = m[1].replace(/^"|"$/g, '');
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(name)) return str;
  return `${encodeHeader(name)} ${m[2]}`;
}

function b64(text) {
  return (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) || []).join('\r\n');
}

const escapeHtml = (t) => String(t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function asHtml(body) {
  const blocks = String(body).replace(/\r\n/g, '\n').split(/\n{2,}/);
  const paras = blocks
    .map((b) => b.replace(/\n+$/, ''))
    .filter((b) => b.trim().length)
    .map((b) => `<p style="margin:0 0 1em 0">${escapeHtml(b).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  // An explicit family and size, because a client left to its own devices
  // renders a plain body in whatever it uses for machine output, and a
  // letter that looks machine generated is read as one.
  return '<html><body style="font-family:Arial,Helvetica,sans-serif;'
    + `font-size:14px;line-height:1.5;color:#000">\n${paras}\n</body></html>`;
}

function mime({ to, cc, from, subject, body, inReplyTo, references }) {
  const esc = (v) => String(v).replace(/[\r\n]/g, ' ').trim();
  const boundary = `gf_${randomUUID().replace(/-/g, '')}`;
  const text = String(body).replace(/\r?\n/g, '\r\n');
  const headers = [
    `From: ${encodeAddress(from)}`,
    `To: ${encodeAddress(to)}`,
    ...(cc && cc.length ? [`Cc: ${cc.map(encodeAddress).join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${esc(inReplyTo)}`, `References: ${esc(references || inReplyTo)}`);
  }
  const raw = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(asHtml(body)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Send one message as one member.
 *
 * `expectAddress` is checked rather than assumed. A member can reconnect a
 * different mailbox at any time, and club outreach going out from somebody's
 * personal address because they picked the wrong Google account on the
 * consent screen is a mistake nobody would notice until a reply arrived
 * somewhere unexpected.
 */
export async function sendAs(userId, { to, subject, body, threadId, inReplyTo, expectAddress, fromName, extraCc }) {
  const { c, acct } = await clientFor(userId);
  if (expectAddress && acct.address.toLowerCase() !== String(expectAddress).toLowerCase()) {
    throw new Error(`Connected mailbox is ${acct.address}, not ${expectAddress}. Reconnect Gmail.`);
  }
  const sent = await call(c, '/messages/send', {
    method: 'POST',
    body: {
      raw: mime({ to, cc: mergeCc(outreachCc(acct.address), extraCc, acct.address, to),
                  from: displayFrom(fromName, acct.address), subject, body,
                  inReplyTo, references: inReplyTo }),
      ...(threadId ? { threadId } : {}),
    },
  });
  return { messageId: sent.id, threadId: sent.threadId, from: acct.address };
}

function header(payload, name) {
  const h = (payload?.headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || null;
}

/** Gmail nests the text part arbitrarily deep once anything is quoted. */
function plainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const found = plainText(part);
    if (found) return found;
  }
  if (payload.body?.data && !payload.mimeType?.startsWith('multipart')) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  return '';
}

/**
 * Everything on one thread that we did not send.
 *
 * Keyed on a thread id WE recorded. This function is the only reader in
 * the codebase and it cannot be pointed at anything else: there is no
 * search, no list, and no query by address, so a member's ordinary mail is
 * never requested in the first place.
 */
export async function inboundOnThread(userId, threadId, { keepOurs = false } = {}) {
  const { c, acct } = await clientFor(userId);
  let thread;
  try {
    thread = await call(c, `/threads/${encodeURIComponent(threadId)}?format=full`);
  } catch (err) {
    // A thread the member deleted is not an error worth stopping a sweep
    // over a hundred other threads for. But it is also exactly what a
    // WRONG CREDENTIAL looks like, and that ambiguity hid a bug that
    // silently discarded replies, so the caller is told rather than left
    // to read an empty array as a quiet week.
    if (err?.response?.status === 404) {
      const e = new Error('thread not in this mailbox');
      e.threadMissing = true;
      throw e;
    }
    throw err;
  }
  const mine = acct.address.toLowerCase();
  return (thread.messages || [])
    .map((msg) => {
      const from = header(msg.payload, 'From') || '';
      return {
        gmailMessageId: msg.id,
        // Everyone the message was addressed to. A reply that answers only
        // the sender quietly removes anybody they had brought into the
        // conversation, and a source who loops in a colleague is a source
        // taking us seriously, so that is the worst moment to drop them.
        toHeader: header(msg.payload, 'To') || '',
        ccHeader: header(msg.payload, 'Cc') || '',
        threadId: msg.threadId,
        from,
        // The RFC header, not Gmail's internal id. Gmail will thread on
        // threadId alone, but every other mail client in the world
        // threads on In-Reply-To, and a source reading us in Outlook
        // should see a conversation rather than a pile.
        rfcMessageId: header(msg.payload, 'Message-ID'),
        subject: header(msg.payload, 'Subject'),
        occurredAt: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
        body: withoutQuotedTail(plainText(msg.payload)),
        isFromUs: from.toLowerCase().includes(mine),
      };
    })
    .filter((m) => keepOurs || !m.isFromUs);
}

/**
 * The part of a reply the person actually wrote.
 *
 * Mail clients quote the entire thread beneath every response, so storing
 * the raw body means a four message exchange holds the first message four
 * times. That is not merely wasteful: an inbox built on it is unreadable,
 * and the MNPI screen would be re-reading our own words back as though
 * they were the source's.
 *
 * Conservative on purpose. Each pattern below is a separator mail clients
 * WRITE, not a guess at prose, and if none matches the body is returned
 * whole. Losing a sentence somebody wrote is worse than keeping a quote.
 */
const QUOTE_MARKERS = [
  // Gmail and Apple Mail. The date is locale-formatted and can contain a
  // narrow no-break space, which is why this is not anchored tightly.
  /^\s*On .{6,120}\s+wrote:\s*$/im,
  // Outlook, both the divider and the header block that follows it.
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^\s*_{10,}\s*$/m,
  /^\s*From:\s.+$\n^\s*Sent:\s.+$/im,
  // Mobile signatures that precede a quote more often than not.
  /^\s*Sent from my (iPhone|iPad|Android|Samsung).*$/im,
];

export function withoutQuotedTail(raw) {
  const body = String(raw || '').replace(/\r\n/g, '\n');
  let cut = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  // A run of quoted lines is its own signal, but only when it is not the
  // whole message: somebody who replies entirely inline deserves to keep
  // what they wrote.
  const quoted = body.match(/^(>.*\n?){2,}/m);
  if (quoted && quoted.index != null && quoted.index > 0 && quoted.index < cut) {
    cut = quoted.index;
  }
  const kept = body.slice(0, cut).trim();
  // Never return nothing. A reply that is only a quote is still evidence
  // that they answered, and the clock keys off that.
  return kept || body.trim();
}

/**
 * What KIND of reply this is, in the vocabulary the follow-up clock already
 * speaks. Deliberately conservative: an auto-reply misread as a real one
 * stops the chase clock on somebody who never actually answered, which is
 * the one classification error that loses a contact silently.
 */
export function classify({ subject, body }) {
  const t = `${subject || ''}\n${body || ''}`.toLowerCase();
  if (/mail delivery|delivery status notification|undeliverable|address not found|550 5\.\d/.test(t)) {
    return 'Bounce';
  }
  if (/out of (the )?office|on leave|annual leave|auto-?reply|automatic reply|away from my desk|maternity|paternity|on vacation/.test(t)) {
    return 'AutoReply';
  }
  if (/unsubscribe|do not contact|not interested|no thank|decline|unable to (help|participate)|have to pass/.test(t)) {
    return 'Declined';
  }
  // Everything else is a person writing back, which is what the clock
  // treats as being heard from. Anything more confident than this would be
  // guessing at somebody's meaning from keywords.
  return 'Reply';
}

export async function connectionFor(userId) {
  const a = await prisma.gmailAccount.findUnique({ where: { userId } });
  if (!a) return { connected: false };
  return {
    connected: !a.revokedAt,
    address: a.address,
    revokedAt: a.revokedAt,
    lastSyncAt: a.lastSyncAt,
  };
}

/**
 * Give the grant back to Google, then forget it.
 *
 * Deleting our row alone leaves a live refresh token in Google's records
 * and the app still listed under the member's third-party access. That
 * matters most in the case disconnect exists for: a binding that should
 * never have happened. Revocation is best-effort because a token Google
 * has already rejected cannot be revoked, and failing to delete our row
 * because of that would leave the bad binding in place.
 */
export async function disconnect(userId) {
  const acct = await prisma.gmailAccount.findUnique({ where: { userId } });
  if (acct?.refreshToken) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: acct.refreshToken }),
      });
    } catch (err) {
      console.warn('gmail revoke failed, deleting the binding anyway:', err.message);
    }
  }
  await prisma.gmailAccount.deleteMany({ where: { userId } });
}
