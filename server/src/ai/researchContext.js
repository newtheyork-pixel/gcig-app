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

// A hard ceiling on this section, in characters.
//
// It is appended to the end of an already long prompt, and a model with
// a bounded window drops the tail first. Silent truncation is the worst
// outcome available here: the model does not know evidence was cut, so
// it answers as though we never gathered it — which is exactly how the
// first version produced "industry norms suggest 1 to 2 times per week"
// under a heading claiming it was our research.
//
// So the budget is explicit, and when it bites the block SAYS what was
// dropped. A model told "12 further findings were omitted for length"
// can say it does not have them to hand. A model handed a quietly
// shortened list cannot tell that anything is missing.
// Raised from 9,000 when the valuation inputs moved in: a comps model
// carries its finding in its assumptions, so those lines are evidence
// rather than padding, and the alternative was findings being pushed out
// by the models that are supposed to answer to them.
const MAX_CHARS = 12_000;

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
      '## Our Own Research and Valuation',
      '_Primary research this club went out and did — interviews we ran,_',
      '_stores we visited, the claim ledger built from them, AND our own_',
      '_valuation models with their inputs. If someone asks what our DCF_',
      '_says, what multiple we have the name on, or what we found in the_',
      '_field, the answer is in this section and nowhere else. Do NOT_',
      '_answer such a question with a generic method explanation. Every_',
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
        out.push('', '**Our valuation work — these are OUR numbers, cite them as ours**');
        for (const v of valuations) {
          // Currency off the row. A DCF in francs rendered with a dollar
          // sign is a different number, and the model will repeat
          // whatever sign it is given.
          const ccy = v.currency || 'USD';
          const money = (n) =>
            n == null ? null : ccy === 'USD' ? `$${Number(n).toLocaleString()}` : `${Number(n).toLocaleString()} ${ccy}`;

          const cases = [money(v.bear), money(v.base), money(v.bull)].filter(Boolean);
          out.push(
            `- **${v.name}** (${v.kind}, as of ${new Date(v.asOf).toISOString().slice(0, 10)})` +
              (cases.length === 3
                ? `: bear ${money(v.bear)} / base ${money(v.base)} / bull ${money(v.bull)}`
                : '') +
              (v.priceAtWrite ? `, against a mark of ${money(v.priceAtWrite)}` : '')
          );

          // A multiple-based method has no price cases, and printing
          // "bear — / base — / bull —" told the model the work was empty
          // when the entire finding was sitting in the assumptions. The
          // inputs ARE the output for a comps model.
          for (const a of (v.assumptions || []).slice(0, 10)) {
            if (!a?.label) continue;
            out.push(
              `    - ${a.label}: ${a.value}${a.unit ? ` ${a.unit}` : ''}` +
                (a.note ? ` (${a.note})` : '')
            );
          }
          // The note carries the judgement — that the base case sits
          // below the current price, that the multiple compressed 42%.
          // Dropping it left only figures with nothing said about them.
          if (v.note) out.push(`    - Read: ${v.note.slice(0, 320)}`);
          // What we are waiting for. "Are we watching anything?" and
          // "how far is Lindt from where we would buy?" are among the
          // most natural things to ask an assistant that holds the
          // valuations, and it could not answer either.
          if (v.buyBelow != null) {
            const gap =
              v.priceAtWrite ? ` — about ${Math.round(((v.buyBelow / v.priceAtWrite) - 1) * 100)}% below the ${money(v.priceAtWrite)} mark it was struck against` : '';
            out.push(
              `    - WE ARE WATCHING TO BUY below ${money(v.buyBelow)}${gap}.` +
                (v.alertedAt
                  ? ` Reached ${new Date(v.alertedAt).toISOString().slice(0, 10)} and still at or under it.`
                  : ' Not reached yet.')
            );
          }
          if (v.reviewBy && new Date(v.reviewBy) < new Date()) {
            out.push(
              `    - STALE: past its review date of ${new Date(v.reviewBy).toISOString().slice(0, 10)}. ` +
                'Say so if anyone asks about this valuation or the level under it.'
            );
          }
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

      // Site visits are fieldwork too, and were missing entirely — a
      // question about what we saw in stores had nothing behind it even
      // though eight visits were logged.
      const visits = await prisma.siteVisit.findMany({
        where: { projectId: p.id },
        orderBy: { visitedAt: 'desc' },
        take: 12,
        include: { siteObservations: { take: 3 } },
      });
      if (visits.length) {
        out.push('', `**Stores and sites we visited (${visits.length})**`);
        for (const vis of visits.slice(0, 8)) {
          const obs = (vis.siteObservations || []).map((o) => o.text).filter(Boolean);
          out.push(
            `- ${vis.location || 'unnamed site'}` +
              (vis.visitedAt ? ` (${new Date(vis.visitedAt).toISOString().slice(0, 10)})` : '') +
              (obs.length ? `: ${obs.join('; ').slice(0, 220)}` : '')
          );
        }
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
        // Tight. This block sits at the very end of a long prompt, and
        // a model with a bounded window drops the tail first: the first
        // cut ran to 20 KB — twice the IPS and policies together — and
        // the model answered a question we HAVE evidence for by
        // reaching for industry norms instead, having never seen it.
        // Fewer, shorter lines that survive beat complete ones that do
        // not arrive.
        const lines = [
          `- **${q.text}**` +
            (employers.size === 1 ? ' — SINGLE SOURCE, uncorroborated' : ` — ${employers.size} independent sources`),
        ];
        for (const c of rows.slice(0, 3)) {
          const src = c.interview?.source;
          const who = [src?.alias, src?.employer].filter(Boolean).join(', ');
          lines.push(
            `    - ${c.text}${c.quote ? ` ("${c.quote.slice(0, 90)}")` : ''}` +
              ` [${who || 'source withheld'}, ${formatStamp(c.startMs)}]`
          );
        }
        if (rows.length > 3) lines.push(`    - (+${rows.length - 3} more on this question)`);
        answered.push(lines.join('\n'));
      }

      if (answered.length) {
        out.push(
          '',
          '**What we found.** Answer from these lines and nothing else. If the',
          'question being asked is not covered below, say we did not establish',
          'it — do NOT substitute industry norms, typical practice or a',
          'plausible range, and never place such a substitute under a heading',
          'that says this is our research. That is inventing a finding.',
          '',
          ...answered
        );
      }
      if (open.length) {
        out.push(
          '',
          `**Asked but never answered (${open.length}).** We have no evidence either ` +
            'way. Saying so is the correct answer:',
          ...open.slice(0, 8).map((t) => `- ${t}`)
        );
      }
      out.push('');
    }

    const text = out.join('\n');
    if (text.length <= MAX_CHARS) return text;

    // Trim on a line boundary so a citation is never cut in half — half
    // a quote with a timestamp still attached is worse than no quote.
    const kept = text.slice(0, MAX_CHARS);
    const trimmed = kept.slice(0, kept.lastIndexOf('\n'));
    const droppedLines = text.slice(trimmed.length).split('\n').filter((l) => l.trim()).length;
    return `${trimmed}\n\n_(${droppedLines} further line(s) of research were omitted here for length. ` +
      `If asked about something not listed above, say we may have it on file but it is not in front of you — ` +
      `do not answer from general knowledge as though it were ours.)_`;
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
