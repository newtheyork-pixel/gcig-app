import prisma from '../db.js';
import { ROLE_RANK } from '../middleware/auth.js';
import { formatStamp } from '../services/transcription.js';

// What our own fieldwork found, for the assistant.
//
// The club's AI knew the portfolio, the votes, the filings, the news and
// the roster, and nothing whatsoever about the research we actually went
// out and did. Seventy claims pinned to seventeen interviews, and asking
// it what we learned about a name got you a shrug.
//
// Three things make this different from every other section of the
// brief, and all three are the reason this file exists separately.
//
// 1. IT IS NOT FOR EVERYONE. /api/research is Analyst-and-above; the
//    assistant is open to every authenticated member. Putting the ledger
//    in the shared cached brief would hand primary research to every
//    JuniorAnalyst and advisory member and quietly route around a gate
//    someone deliberately set. So this is built per-user and returns
//    nothing at all below that bar.
//
// 2. SOURCES ARE NEVER NAMED. A citation carries the alias, the
//    relationship and the timestamp — never the real name, which does
//    not leave the server anywhere else either and must not start
//    leaving it through a chatbot.
//
// 3. THIN EVIDENCE MUST READ AS THIN. One person saying something once
//    is not a finding, and a model handed a flat list of assertions will
//    state them all with equal confidence. Every line carries how many
//    independent employers stand behind it, and single-source lines say
//    so in the text rather than in a column the model may ignore.

const MIN_RANK = ROLE_RANK.Analyst;

// Interviews whose claims may be repeated to anyone. Quarantined is the
// obvious exclusion. The subtler one is an interview the screen flagged
// and no person has cleared: it may contain material non-public
// information, and the whole point of flagging it was to stop it being
// used before someone looked. An assistant reciting it to the club is
// exactly the use that was meant to be blocked.
const CITABLE_INTERVIEW = {
  quarantined: false,
  OR: [{ mnpiRisk: 'low' }, { reviewedAt: { not: null } }],
};

function canSeeResearch(user) {
  if (!user) return false;
  const ranks = [user.role, ...(user.extraRoles || [])].map((r) => ROLE_RANK[r] || 0);
  return Math.max(0, ...ranks) >= MIN_RANK;
}

/**
 * Returns a markdown block for the system prompt, or '' when the user is
 * not entitled to it or there is nothing to say. Never throws — the
 * assistant answering without this section is a degraded answer; the
 * assistant failing to load is a broken product.
 */
export async function buildResearchContext(user) {
  if (!canSeeResearch(user)) return '';

  try {
    const projects = await prisma.researchProject.findMany({
      where: { status: { not: 'Closed' } },
      orderBy: { updatedAt: 'desc' },
      take: 6,
      include: {
        questions: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
        valuations: { orderBy: { asOf: 'desc' }, take: 3 },
        _count: { select: { interviews: true } },
      },
    });
    if (projects.length === 0) return '';

    const out = [
      '',
      '---',
      '',
      '## Our Own Field Research',
      '_Primary research this club went out and did: interviews we ran,_',
      '_stores we visited, and the claim ledger built from them. Every_',
      '_claim below is pinned to a recording at a timestamp and can be_',
      '_played back. This is OUR work — cite it as ours, not as "reports_',
      '_suggest". Alias the source; never invent a real name for one._',
      '',
      '**Weigh it honestly.** "1 source" means one person said it once and',
      '**nothing corroborates it** — say so when you use it. Two colleagues',
      'at the same employer are one line of evidence, not two.',
      '',
    ];

    for (const p of projects) {
      const claims = await prisma.researchClaim.findMany({
        where: { interview: { projectId: p.id, ...CITABLE_INTERVIEW } },
        include: {
          interview: {
            select: {
              conductedAt: true,
              source: { select: { alias: true, relationship: true, employer: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
      });

      out.push(`### ${p.ticker ? `${p.ticker} — ` : ''}${p.name}  _(${p.status})_`);
      if (p.brief) out.push(`Brief: ${p.brief.slice(0, 400)}`);
      out.push(
        `${p._count.interviews} interview(s), ${claims.length} citable claim(s).`
      );

      const valuations = p.valuations || [];
      if (valuations.length) {
        out.push('', '**Our price targets**');
        for (const v of valuations) {
          const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
          out.push(
            `- ${v.name} (${v.kind}): bear ${money(v.bear)} / base ${money(v.base)} / bull ${money(v.bull)}` +
              (v.priceAtWrite ? `, struck against ${money(v.priceAtWrite)}` : '') +
              ` — as of ${new Date(v.asOf).toISOString().slice(0, 10)}`
          );
        }
      }

      // Group by question so the model sees evidence against the thing it
      // was gathered to answer, rather than a heap of assertions.
      const byQ = new Map();
      for (const c of claims) {
        const k = c.questionId ?? 'unasked';
        if (!byQ.has(k)) byQ.set(k, []);
        byQ.get(k).push(c);
      }

      const answered = [];
      const open = [];
      for (const q of p.questions) {
        const rows = byQ.get(q.id) || [];
        if (rows.length === 0) {
          open.push(q.text);
          continue;
        }
        const employers = new Set(
          rows.map((c) => c.interview?.source?.employer || `unknown:${c.id}`)
        );
        const lines = [`- **${q.text}** — ${employers.size} independent source(s)`];
        for (const c of rows.slice(0, 4)) {
          const src = c.interview?.source;
          const who = [src?.alias, src?.relationship, src?.employer]
            .filter(Boolean)
            .join(', ');
          lines.push(
            `    - ${c.text}${c.quote ? ` — "${c.quote.slice(0, 160)}"` : ''} ` +
              `[${who || 'source withheld'}, ${fmtDay(c.interview?.conductedAt)}, ${formatStamp(c.startMs)}]` +
              (employers.size === 1 ? ' — SINGLE SOURCE, uncorroborated' : '')
          );
        }
        answered.push(lines.join('\n'));
      }

      if (answered.length) out.push('', '**What we found**', ...answered);
      if (open.length) {
        out.push(
          '',
          `**Still unanswered (${open.length})** — we have no evidence either way on these. ` +
            'Do not fill the gap from general knowledge and present it as our finding:',
          ...open.slice(0, 12).map((t) => `- ${t}`)
        );
      }
      out.push('');
    }

    return out.join('\n');
  } catch (err) {
    console.warn('researchContext failed:', err.message);
    return '';
  }
}

function fmtDay(d) {
  if (!d) return 'date unknown';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? 'date unknown' : dt.toISOString().slice(0, 10);
}
