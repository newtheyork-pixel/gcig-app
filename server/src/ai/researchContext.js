import prisma from '../db.js';
import { ROLE_RANK, isSuperAdminEmail } from '../middleware/auth.js';
import { formatStamp } from '../services/transcription.js';
import { retrieve } from './retrieve.js';

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

// What the retrieved evidence may occupy.
//
// Far smaller than the 12,000-character dump it replaced, because the
// point is no longer to fit everything. That approach failed twice over:
// it truncated blindly at a character count, so the answer was dropped
// whenever it happened to sort last — and even when it survived, it
// arrived buried in twelve kilobytes the model read straight past,
// answering "we did not establish any valuation methods" with the DCF
// sitting in front of it. Sending the right 4,500 characters beats
// sending all 12,000.
const RETRIEVE_BUDGET = 4_500;

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

/// One shape for both halves of the project query.
const PROJECT_INCLUDE = {
  questions: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
  valuations: { orderBy: { asOf: 'desc' }, take: 3 },
  _count: { select: { interviews: true } },
};

/**
 * Returns a markdown block for the system prompt, or '' when the user is
 * not entitled to it or there is nothing to say. Never throws — the
 * assistant answering without this section is a degraded answer; the
 * assistant failing to load is a broken product.
 */
// Does this conversation actually concern this project?
//
// The whole ledger was included on every message. Twelve kilobytes of
// Lindt fieldwork in front of a question about AIT is not context, it is
// noise, and a local model reads it as the subject: asked what AIT was
// trading at, prod answered about chocolate restocking eight times
// running and never called the quote tool at all.
//
// So detail is pulled in when the conversation is about the name, and
// otherwise the project appears as a single line saying it exists. The
// model can still say we have research on Lindt; it just is not made to
// read all of it to answer a question about something else.
function mentions(topic, project) {
  if (!topic) return false;
  const t = String(topic).toLowerCase();
  if (project.ticker && new RegExp(`\\b${project.ticker.toLowerCase()}\\b`).test(t)) return true;
  // Project names are like "Lindt & Sprüngli — 2026 field study"; match
  // on their distinctive words rather than the whole string.
  return String(project.name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3)
    .some((w) => t.includes(w));
}

export async function buildResearchContext(user, topic = '') {
  if (!canSeeResearch(user)) return '';

  try {
    // Owner-only projects are gated in four places in routes/research.js
    // and were gated in none of them here, so the assistant was reading
    // out projects the same member is refused over the API. A privacy
    // rule enforced on one surface and not the other is not a rule.
    const visibility = isSuperAdminEmail(user?.email) ? {} : { ownerOnly: false };

    // Recency alone was the wrong window. Importing thirty-nine archive
    // projects one afternoon stamped them all newer than the two we
    // actually work, so `take: 6` filled with folders of PDFs and the
    // assistant lost every claim it had — asked about Lindt it would
    // have said we had no fieldwork, which was false and looked like a
    // retrieval bug rather than an ordering one.
    //
    // So a project the conversation NAMES is fetched regardless of when
    // it was last touched, and recency only fills what is left.
    const named = topic
      ? await prisma.researchProject.findMany({
        where: { ...visibility, status: { not: 'Closed' } },
        orderBy: { updatedAt: 'desc' },
        include: PROJECT_INCLUDE,
      }).then((all) => all.filter((p) => mentions(topic, p)).slice(0, 4))
      : [];

    const recent = await prisma.researchProject.findMany({
      where: {
        ...visibility,
        status: { not: 'Closed' },
        ...(named.length ? { id: { notIn: named.map((p) => p.id) } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(0, 6 - named.length),
      include: PROJECT_INCLUDE,
    });
    const projects = [...named, ...recent];
    if (projects.length === 0) return '';

    // Everything we could say, as addressable pieces. What actually
    // goes in the prompt is chosen from these by relevance — see
    // retrieve.js for why stuffing the lot stopped working.
    const chunks = [];

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
      '**"We did not establish that" belongs to THIS section only.** It is',
      'the right answer about our fieldwork and the wrong answer about a',
      'share price, a filing or general market knowledge — asked what',
      'Apple was trading at, an earlier version said we had not',
      'established it while a good quote sat in front of it. Market data',
      'comes from your tools; use them and answer.',
      '',
      '**This section covers ONLY the projects named below.** It says',
      'nothing about any other company, and it is not the subject of',
      'every question. Asked about a ticker that does not appear here,',
      'answer the question actually asked and do not drag this research',
      'into it. Reporting one company\'s price under another company\'s',
      'name is a serious error, and it has already happened once.',
      '',
    ];

    // If nothing in the conversation names a project, every project is
    // listed but none is expanded. Asking about one pulls it in.
    const relevant = projects.filter((p) => mentions(topic, p));
    const expand = new Set((relevant.length ? relevant : []).map((p) => p.id));

    if (expand.size === 0) {
      out.push(
        '**Nothing in this conversation names one of these projects, so the',
        'detail is not loaded.** They exist and you can say so. If the member',
        'asks about one by name or ticker, say you can pull it up — do not',
        'answer about it from memory, and do not treat these names as the',
        'subject of an unrelated question.',
        ''
      );
      for (const p of projects) {
        out.push(
          `- ${p.ticker ? `${p.ticker} — ` : ''}${p.name} (${p.status}), ` +
            `${p._count.interviews} interview(s)`
        );
      }
      return out.join('\n');
    }

    for (const p of projects.filter((x) => expand.has(x.id))) {
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

      chunks.push({
        id: `hdr${p.id}`,
        kind: 'header',
        always: true,
        text: [
          `### ${p.ticker ? `${p.ticker} — ` : ''}${p.name}  _(${p.status})_`,
          p.brief ? `Brief: ${p.brief.slice(0, 240)}` : null,
          `${p._count.interviews} interview(s), ${claims.length} citable claim(s).`,
        ].filter(Boolean).join('\n'),
      });

      const valuations = p.valuations || [];
      {
        for (const v of valuations) {
          // Currency off the row. A DCF in francs rendered with a dollar
          // sign is a different number, and the model will repeat
          // whatever sign it is given.
          const ccy = v.currency || 'USD';
          const money = (n) =>
            n == null ? null : ccy === 'USD' ? `$${Number(n).toLocaleString()}` : `${Number(n).toLocaleString()} ${ccy}`;

          const vlines = [];
          const cases = [money(v.bear), money(v.base), money(v.bull)].filter(Boolean);
          vlines.push(
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
            vlines.push(
              `    - ${a.label}: ${a.value}${a.unit ? ` ${a.unit}` : ''}` +
                (a.note ? ` (${a.note})` : '')
            );
          }
          // The note carries the judgement — that the base case sits
          // below the current price, that the multiple compressed 42%.
          // Dropping it left only figures with nothing said about them.
          if (v.note) vlines.push(`    - Read: ${v.note.slice(0, 320)}`);
          // What we are waiting for. "Are we watching anything?" and
          // "how far is Lindt from where we would buy?" are among the
          // most natural things to ask an assistant that holds the
          // valuations, and it could not answer either.
          if (v.buyBelow != null) {
            const gap =
              v.priceAtWrite ? ` — about ${Math.round(((v.buyBelow / v.priceAtWrite) - 1) * 100)}% below the ${money(v.priceAtWrite)} mark it was struck against` : '';
            vlines.push(
              `    - WE ARE WATCHING TO BUY below ${money(v.buyBelow)}${gap}.` +
                (v.alertedAt
                  ? ` Reached ${new Date(v.alertedAt).toISOString().slice(0, 10)} and still at or under it.`
                  : ' Not reached yet.')
            );
          }
          if (v.reviewBy && new Date(v.reviewBy) < new Date()) {
            vlines.push(
              `    - STALE: past its review date of ${new Date(v.reviewBy).toISOString().slice(0, 10)}. ` +
                'Say so if anyone asks about this valuation or the level under it.'
            );
          }
          chunks.push({
            id: `val${v.id}`,
            kind: 'valuation',
            text: ['**Our valuation work — these are OUR numbers, cite them as ours**', ...vlines].join('\n'),
          });
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
        answered.push({ id: `q${q.id}`, kind: 'finding', text: lines.join('\n') });
      }

      chunks.push(...answered);
      // Rendered AFTER the findings, deliberately.
      //
      // This section has a hard character budget and the tail is what
      // gets dropped. With visits above them, 2.7 KB of site notes
      // survived while 28 lines of findings — each a pinned, timestamped
      // quote — were cut. Observations are real evidence but they are
      // the weaker kind: there is no recording to walk back to. If
      // something has to go, it should be this.
      for (const vis of visits.slice(0, 8)) {
        const obs = (vis.siteObservations || []).map((o) => o.text).filter(Boolean);
        chunks.push({
          id: `v${vis.id}`,
          kind: 'visit',
          text:
            `- ${vis.location || 'unnamed site'}` +
            (vis.visitedAt ? ` (${new Date(vis.visitedAt).toISOString().slice(0, 10)})` : '') +
            (obs.length ? `: ${obs.join('; ').slice(0, 220)}` : ''),
        });
      }

      if (open.length) {
        chunks.push({
          id: 'open',
          kind: 'open',
          text: [
            `**Asked but never answered (${open.length}).** We have no evidence either ` +
              'way. Saying so is the correct answer:',
            ...open.slice(0, 8).map((t) => `- ${t}`),
          ].join('\n'),
        });
      }
    }

    // Relevance, not truncation.
    //
    // The old path assembled everything and cut the tail at a character
    // count, which meant the answer to the question being asked was
    // dropped whenever it happened to sort last — and even when it
    // survived, it arrived buried in twelve kilobytes the model read
    // past. Now the question chooses what goes in.
    const { text, omitted } = retrieve(chunks, topic, { budget: RETRIEVE_BUDGET });
    out.push(text);

    if (omitted.length) {
      // Named by kind and counted. A model handed a short list with no
      // note reads it as everything we have, which is exactly how an
      // earlier version presented industry norms as our findings.
      const byKind = {};
      for (const c of omitted) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
      const parts = Object.entries(byKind)
        .map(([k, n]) => `${n} ${k === 'finding' ? 'further finding(s)' : k === 'visit' ? 'store visit note(s)' : `${k} item(s)`}`)
        .join(', ');
      out.push(
        '',
        `_Not shown for this question: ${parts}. They exist and are on file.` +
          ' If asked about something not above, say you can look it up — do NOT' +
          ' answer from general knowledge as though it were ours._'
      );
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
