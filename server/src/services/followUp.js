// When to chase someone, and when to leave them alone.
//
// Thirteen emails went out on the CHRW project and one person answered.
// The other twelve are not refusals, they are silence, and silence has a
// shelf life: chase too early and you are the student who emailed twice
// in three days, chase too late and the thread is cold. Nobody wants to
// hold twelve dates in their head, so the panel holds them.
//
// Two rules do the work.
//
// ELAPSED TIME IS COUNTED IN WORKING DAYS. An email sent on Friday
// afternoon has been sitting for one working day by Monday, not three,
// and treating the weekend as waiting time is what produces a follow-up
// that arrives before the first email has been read. Counting this way
// also means a recommendation can never come due on a Saturday: adding
// working days to a date always lands on a working day.
//
// A REPLY ENDS IT. Not an out-of-office, which is a robot confirming
// nobody has read anything, and not a bounce, which is a bad address and
// wants a new one rather than the same message again.

/// US federal holidays, which are when the people we are writing to are
/// not at their desks. The rule Thomas actually described was the long
/// weekend, and a long weekend is a public holiday attached to one.
///
/// Computed rather than listed so the table never expires.
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + (n - 1) * 7));
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - shift));
}

/// A holiday falling at the weekend is observed on the adjacent weekday,
/// which is exactly the case that creates the long weekend.
function observed(d) {
  const day = d.getUTCDay();
  if (day === 6) return new Date(d.getTime() - 86400000);
  if (day === 0) return new Date(d.getTime() + 86400000);
  return d;
}

const holidayCache = new Map();

export function holidaysFor(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const fixed = [[0, 1], [5, 19], [6, 4], [10, 11], [11, 25]];
  const set = new Set();
  for (const [m, day] of fixed) {
    set.add(observed(new Date(Date.UTC(year, m, day))).toISOString().slice(0, 10));
  }
  set.add(nthWeekday(year, 0, 1, 3).toISOString().slice(0, 10));   // MLK
  set.add(nthWeekday(year, 1, 1, 3).toISOString().slice(0, 10));   // Presidents
  set.add(lastWeekday(year, 4, 1).toISOString().slice(0, 10));     // Memorial
  set.add(nthWeekday(year, 8, 1, 1).toISOString().slice(0, 10));   // Labor
  set.add(nthWeekday(year, 9, 1, 2).toISOString().slice(0, 10));   // Columbus
  set.add(nthWeekday(year, 10, 4, 4).toISOString().slice(0, 10));  // Thanksgiving
  holidayCache.set(year, set);
  return set;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

export function isWorkingDay(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !holidaysFor(d.getUTCFullYear()).has(iso(d));
}

/// Working days from `from` to `to`, counting neither endpoint's
/// partial day. Sent Friday, read Monday: one working day has passed.
export function workingDaysBetween(from, to) {
  const a = new Date(Date.UTC(
    new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()));
  const b = new Date(Date.UTC(
    new Date(to).getUTCFullYear(), new Date(to).getUTCMonth(), new Date(to).getUTCDate()));
  if (b <= a) return 0;
  let n = 0;
  const cur = new Date(a);
  while (cur < b) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (isWorkingDay(cur)) n += 1;
  }
  return n;
}

export function addWorkingDays(from, n) {
  const d = new Date(Date.UTC(
    new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()));
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(d)) left -= 1;
  }
  return d;
}

/// How long to wait before each chase.
///
/// Five working days is a week of theirs — long enough that a person who
/// meant to reply has had the chance and short enough that the thread is
/// still warm. The second wait is longer because a second silence means
/// something different from the first. There is no third: two unanswered
/// follow-ups is an answer, and the honest move is to stop rather than
/// keep a dead name in the queue.
const WAITS = [5, 8];

const NEVER_CHASE = new Set(['Declined', 'Completed', 'Unreachable']);

/**
 * What to do about one target, and when.
 *
 * Returns a state plus the working-day arithmetic behind it, so the
 * panel can show the reasoning rather than an unexplained badge.
 * `state` is one of:
 *   answered  — a human replied; nothing to chase
 *   bounced   — bad address; needs a new one, not another send
 *   closed    — declined, completed or already given up on
 *   owed      — they wrote, we have not written back
 *   drafted   — they wrote, an answer exists but has not left yet
 *   waiting   — sent, too early to chase, `dueAt` says when
 *   due       — chase now
 *   overdue   — should have been chased already
 *   exhausted — chased twice with no answer; stop
 *   none      — nothing has been sent yet
 */
export function assessTarget(target, now = new Date()) {
  const msgs = [...(target?.messages || [])].sort(
    (a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  const inbound = msgs.filter((m) => m.direction === 'in');
  const outbound = msgs.filter((m) => m.direction === 'out');
  const sentDrafts = (target?.drafts || []).filter((d) => d.sentAt);

  const base = { targetId: target?.id, name: target?.name };

  if (inbound.some((m) => m.kind === 'Bounce')) {
    return { ...base, state: 'bounced',
      recommendation: 'The address bounced. Find another route before sending anything else.' };
  }
  if (NEVER_CHASE.has(String(target?.status || ''))) {
    return { ...base, state: 'closed', recommendation: null };
  }

  // A real reply, from a person. An auto-reply is not one.
  const answered = inbound.filter((m) => m.kind !== 'AutoReply');
  const last = msgs[msgs.length - 1];
  if (answered.length) {
    if (last && last.direction === 'in' && last.kind !== 'AutoReply') {
      // An answer that is WRITTEN but not yet gone is not silence. This
      // state is computed from the message ledger, which only learns about
      // a letter once it leaves, so a reply scheduled for a civil hour or
      // parked in somebody's mail client read exactly like ignoring the
      // person. Two of the four live conversations were in that state at
      // once, which is how a real "owed" stops being believed.
      const pending = (target?.drafts || []).find(
        (d) => !d.sentAt && !d.rejectedAt
          && new Date(d.createdAt || 0) >= new Date(last.occurredAt));
      if (pending) {
        return { ...base, state: 'drafted',
          lastInboundAt: last.occurredAt,
          recommendation: pending.scheduledFor
            ? 'An answer is written and queued to send.'
            : pending.queuedAt
            ? 'An answer is written and sitting in a mailbox, waiting to go.'
            : 'An answer is written and waiting to be sent.' };
      }
      return { ...base, state: 'owed',
        lastInboundAt: last.occurredAt,
        waitingDays: workingDaysBetween(last.occurredAt, now),
        recommendation: 'They wrote back and we have not answered.' };
    }
    return { ...base, state: 'answered', recommendation: null };
  }

  // The clock runs from the last thing WE sent, whether that was the
  // original draft or a chase already logged.
  const stamps = [
    ...sentDrafts.map((d) => d.sentAt),
    ...outbound.map((m) => m.occurredAt),
  ].filter(Boolean).sort((a, b) => new Date(b) - new Date(a));
  if (!stamps.length) return { ...base, state: 'none', recommendation: null };

  const lastOutboundAt = stamps[0];
  // An out-of-office resets the clock to the day they said they were
  // back at work rather than the day we wrote — chasing someone on
  // holiday achieves nothing except arriving in a full inbox.
  const auto = inbound.filter((m) => m.kind === 'AutoReply')
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0];
  const from = auto && new Date(auto.occurredAt) > new Date(lastOutboundAt)
    ? auto.occurredAt : lastOutboundAt;

  const attempt = stamps.length;           // 1 = original, 2 = first chase
  if (attempt > WAITS.length) {
    return { ...base, state: 'exhausted', lastOutboundAt, attempts: attempt,
      recommendation: 'Chased twice with no reply. Mark them unreachable and spend the time on someone else.' };
  }

  const wait = WAITS[attempt - 1];
  let dueDate = addWorkingDays(from, wait);

  // A human may have read the actual sentence. "Returning August 24" is
  // information the ARRIVAL TIME of an auto-reply does not contain, and
  // resetting to arrival alone sent chases at empty desks.
  //
  // followUpAfter caps the DUE DATE, not the start of the countdown.
  // Starting the clock there instead would push a chase five working
  // days past the day somebody got back, which is the opposite of the
  // point. It only ever moves the date later: whichever of the computed
  // date and the floor is further out wins, so recording a return date
  // can delay a chase and never pull one forward into a holiday.
  const floor = target?.followUpAfter ? new Date(target.followUpAfter) : null;
  if (floor && !Number.isNaN(floor.getTime()) && floor > dueDate) dueDate = floor;

  const elapsed = workingDaysBetween(from, now);
  const overdueFrom = addWorkingDays(dueDate, 3);
  const state = now >= dueDate ? (now >= overdueFrom ? 'overdue' : 'due') : 'waiting';

  const which = attempt === 1 ? 'follow-up' : 'second follow-up';
  const dueISO = iso(dueDate);
  const dayName = dueDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

  return {
    ...base,
    state,
    attempts: attempt,
    lastOutboundAt,
    clockFrom: from,
    autoReplyReset: from !== lastOutboundAt,
    workingDaysWaited: elapsed,
    waitTarget: wait,
    dueAt: dueISO,
    dueDay: dayName,
    recommendation: state === 'waiting'
      ? `Sent ${elapsed} working ${elapsed === 1 ? 'day' : 'days'} ago. Send the ${which} on ${dayName} ${dueISO}.`
      : `Send the ${which} — ${elapsed} working days with no reply.`,
  };
}

/// The whole project's chase list, soonest first, with the counts a
/// panel header needs.
export function assessOutreach(targets, now = new Date()) {
  const rows = (targets || []).map((t) => assessTarget(t, now));
  const rank = { overdue: 0, due: 1, owed: 2, waiting: 3, exhausted: 4, bounced: 5 };
  const actionable = rows
    .filter((r) => ['overdue', 'due', 'owed'].includes(r.state))
    .sort((a, b) => (rank[a.state] - rank[b.state]) || (a.dueAt || '').localeCompare(b.dueAt || ''));
  return {
    rows,
    dueNow: actionable.length,
    counts: rows.reduce((acc, r) => { acc[r.state] = (acc[r.state] || 0) + 1; return acc; }, {}),
    // The next date anything comes due, so a panel with nothing to do
    // today can still say when that changes.
    nextDueAt: rows.filter((r) => r.state === 'waiting')
      .map((r) => r.dueAt).sort()[0] || null,
  };
}
