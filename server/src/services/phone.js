// Turning what somebody typed into something you can actually ring.
//
// Store numbers arrive from mall directories, store locators and other
// people's spreadsheets, in every shape a human writes a phone number.
// Two failure modes are worth designing against, and only one of them is
// obvious.
//
// The obvious one is a number too mangled to dial. That is cheap: it
// fails at the handset and somebody fixes the row.
//
// The dangerous one is an extension. "(614) 555-0134 x231" normalised to
// +16145550134 is a VALID number that reaches the wrong end of the
// business, and nothing downstream can tell that the row is wrong — the
// call connects, a person answers, and the log says the store was
// reached. So extensions are parsed and carried, never dropped.
//
// Validation follows the North American Numbering Plan rather than
// counting digits: an area code or exchange beginning 0 or 1 does not
// exist, and neither does an N11 area code. That catches the typo class
// that matters here, a digit dropped or doubled while copying a store
// locator, which otherwise produces a plausible-looking number for a
// door that is not the one in the sample.

const EXT_RE = /(?:\s|^)(?:x|ext|extn|extension)\.?\s*:?\s*(\d{1,6})\s*$/i;

/** NANP area code / exchange: first digit 2-9, and not N11. */
function validNanpPrefix(three) {
  if (!/^[2-9]\d\d$/.test(three)) return false;
  if (three[1] === '1' && three[2] === '1') return false;
  return true;
}

/**
 * Parse a human-written phone number.
 *
 * @param {string} raw
 * @returns {{ e164: string, ext: string|null }|null} null when it is not
 *   a number we are willing to hand to a dialler.
 */
export function parsePhone(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Guard against a pasted paragraph before any of the regexes run.
  if (s.length > 60) return null;

  let ext = null;
  const extMatch = s.match(EXT_RE);
  if (extMatch) {
    ext = extMatch[1];
    s = s.slice(0, extMatch.index).trim();
  }
  // The other extension spelling: a semicolon or comma tail, as tel:
  // URLs and contact exports write it.
  const tail = s.match(/[;,]\s*(?:ext=)?(\d{1,6})\s*$/i);
  if (tail && !ext) {
    ext = tail[1];
    s = s.slice(0, tail.index).trim();
  }

  const intl = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (intl && !digits.startsWith('1')) {
    // Anything outside the NANP: we can carry it and dial it, but we
    // cannot check it, so the length bounds from E.164 are all there is.
    if (digits.length < 8 || digits.length > 15) return null;
    return { e164: `+${digits}`, ext };
  }

  let national = digits;
  if (national.length === 11 && national.startsWith('1')) national = national.slice(1);
  if (national.length !== 10) return null;
  if (!validNanpPrefix(national.slice(0, 3))) return null;
  if (!validNanpPrefix(national.slice(3, 6))) return null;

  return { e164: `+1${national}`, ext };
}

/** Display form. US numbers get the shape people read; others stay E.164. */
export function formatPhone(parsed) {
  if (!parsed?.e164) return '';
  const { e164, ext } = parsed;
  let out = e164;
  if (/^\+1\d{10}$/.test(e164)) {
    const n = e164.slice(2);
    out = `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  }
  return ext ? `${out} ext. ${ext}` : out;
}

/**
 * The URL the terminal hands to the system dialler.
 *
 * The extension rides as `;ext=`, which is the RFC 3966 form. Whether a
 * given handset then dials it is out of our hands — what matters is that
 * it is IN the link, so a call that reaches the wrong desk is a device
 * behaviour somebody can see rather than data we quietly discarded.
 */
export function telUrl(parsed) {
  if (!parsed?.e164) return null;
  return parsed.ext ? `tel:${parsed.e164};ext=${parsed.ext}` : `tel:${parsed.e164}`;
}
