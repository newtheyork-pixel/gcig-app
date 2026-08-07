# Sentiment Analysis for the Terminal (SENT)

Research and proposal, prepared 2026-08-07. Part 1 is what FactSet
actually sells and how the field does document sentiment, every fact
pinned to a URL. Part 2 is a concrete design for this codebase.

---

## Part 1: How FactSet does it

FactSet's sentiment offering is really three layers: a licensed
transcript corpus, a partner-built machine-learning scoring feed on
top of it, and a GenAI assistant in the workstation. The exact scoring
model is not public; what follows is what FactSet documents.

### Layer 1: the transcript corpus (Events and Transcripts DataFeed)

- FactSet sells earnings-call transcripts as a structured XML feed,
  released in this form in 2017 explicitly "to facilitate natural
  language processing." Coverage begins in 2000 for events and 2003
  for transcripts.
  Source: https://www.globenewswire.com/news-release/2017/06/22/1027695/0/en/FactSet-Releases-Events-and-Transcripts-Data-Feed-to-Facilitate-Natural-Language-Processing.html
- The XML tags "management discussion, question and answer, the
  speaker, and the type of interaction (type q is for question and a
  is answer)," and maps each speaker to FactSet's permanent person and
  employer identifiers. Events are covered for 40,000+ companies a
  year, with transcripts for roughly 10,000 of them. Each call ships
  twice: "the raw version is the first to market and the corrected
  version is a secondary release that has been manually reviewed by
  FactSet's team of analysts." The stated purpose of the format is to
  "power sentiment and natural language processing (NLP) models."
  Source: https://insight.factset.com/resources/at-a-glance-document-distributor-xml-company-events-transcript-datafeed
- The inputs scored are therefore calls (earnings, investor days,
  conferences), not just filings, and the corpus itself already
  carries the two distinctions the literature says matter: prepared
  remarks vs Q&A, and who is speaking (management vs analyst).
  Source: same at-a-glance page as above.

### Layer 2: the scoring (Alexandria sentiment, sold through FactSet)

The sentiment scores themselves come from Alexandria Technology, a
partner whose feeds FactSet distributes through its marketplace.

- Unit of scoring: the section, not the document. "Each transcript is
  parsed into many sections of structured data" and each section gets
  topic, sentiment, speaker, and metadata.
  Source: https://insight.factset.com/resources/at-a-glance-alexandria-transcripts
- Method: machine learning, not a dictionary. The classifiers are
  "trained by buy-side research analysts to replicate their own
  analysis, which yields more accurate and consistent
  classifications," and the training explicitly accounts for
  management bias (management talks itself up, so a naive reading of
  management language runs optimistic).
  Source: https://insight.factset.com/resources/at-a-glance-alexandria-transcripts
- Scale: 430,000+ transcripts, 18,000+ public companies, history back
  to 2003, over 250 topics as of April 2020, event-driven updates
  delivered hourly.
  Sources: https://www.factset.com/marketplace/catalog/product/alexandria-sentiment-earnings-calls and https://insight.factset.com/resources/at-a-glance-alexandria-transcripts
- FactSet's own case study for why ML beats word counts: a strategy
  built on Alexandria's sentiment returned "9.6% annual return" while
  the identical strategy on dictionary-generated sentiment returned
  "-2.2% annual return."
  Source: https://insight.factset.com/resources/at-a-glance-alexandria-transcripts
- Score range and aggregation weights: NOT published on the public
  pages. Unsourced, do not use: any specific claim about Alexandria's
  score scale (for example "-1 to +1") or how section scores roll up
  to a call-level number. The public pages say sections are classified
  for sentiment and topic; they do not give the scale.

### Layer 3: the workstation (Transcript Assistant, FactSet Mercury)

- Transcript Assistant (released March 12, 2024) is a GenAI chatbot
  over the transcript corpus: summaries per section and per speaker,
  natural-language search, "high-level summaries, high/low takeaways,
  updated management guidance, and key themes shortly after the call
  ends."
  Source: https://www.stocktitan.net/news/FDS/fact-set-releases-transcript-assistant-a-game-changing-ai-tool-for-9yov1bioc939.html (mirror of the FactSet press release at https://investor.factset.com/news-releases/news-release-details/factset-releases-transcript-assistant-game-changing-ai-tool/)
- It is "powered by FactSet Mercury," which FactSet describes as "a
  Large Language Model-based knowledge agent," and it "visualizes call
  sentiments" and summarizes the management/analyst Q&A. So the
  deliverable a workstation user sees is: transcript, sentiment
  visualization over the call, and LLM summaries, side by side.
  Source: https://insight.factset.com/have-you-put-your-factset-ai-assistant-to-work-for-peak-earnings-season
- For flavor, FactSet's insight blog has also demonstrated DIY
  sentence-level scoring of calls with NLTK's VADER model, splitting
  prepared remarks from Q&A and comparing an individual analyst's
  average tone (0.111) against the call average (0.189). That is a
  demo, not the product methodology, but it shows the units FactSet
  thinks in: per sentence, per speaker, per call section.
  Source: https://insight.factset.com/interpreting-earnings-calls-with-natural-language-processing

Plainly: FactSet does not publish the Alexandria model internals, the
feature set, or the score scale. What IS documented is the shape:
licensed call transcripts, parsed to sections with speaker and Q&A
tags, scored by ML classifiers trained by financial analysts to
correct for management bias, delivered as a feed plus an LLM assistant
in the workstation.

### The standard approaches a club can borrow

1. **Loughran-McDonald dictionary (the finance word-count baseline).**
   Loughran and McDonald (Journal of Finance 2011) showed that almost
   three quarters of "negative" words in the general-purpose Harvard
   dictionary are not negative in financial text (tax, cost, capital,
   liability), and built six finance-specific word lists: negative,
   positive, litigious, uncertainty, constraining, superfluous. Tone
   is then a word count, typically net negative words over total
   words. The master dictionary is freely downloadable from Notre
   Dame's Software Repository for Accounting and Finance.
   Sources: https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.2010.01625.x and https://sraf.nd.edu/loughranmcdonald-master-dictionary/
2. **FinBERT (supervised transformer).** Two lineages: Araci (2019,
   arXiv:1908.10063) fine-tuned BERT for financial sentiment and beat
   the then state of the art; Yang et al. (2020, arXiv:2006.08097)
   pretrained BERT on financial communications and fine-tuned on
   10,000 manually annotated analyst-report sentences. Both are free
   on Hugging Face / GitHub and classify one sentence at a time as
   positive/negative/neutral.
   Sources: https://arxiv.org/abs/1908.10063 and https://arxiv.org/abs/2006.08097 and https://github.com/yya518/FinBERT and https://github.com/ProsusAI/finBERT
3. **LLM scoring (prompt a general model).** Lopez-Lira and Tang
   showed ChatGPT-scored news headlines carry statistically
   significant predictive power for next-day cross-sectional returns
   and outperform traditional sentiment measures, without any
   finance-specific training.
   Source: https://www.dirk.org/wp-content/uploads/2023/06/Can-ChatGPT-Forecast-Stock-Price-Movements.pdf (also http://wp.lancs.ac.uk/fofi2024/files/2024/04/FoFI-2024-139-Alejandro-Lopez-Lira.pdf)

### Known pitfalls (each one shapes the design in Part 2)

- **Generic lexicons misread finance.** The 2011 Loughran-McDonald
  result above is the canonical case; their 2016 survey (Journal of
  Accounting Research 54(4)) is the standard catalogue of
  implementation tripwires and stresses that textual measures are far
  less precise than quantitative ones. Word counting also ignores
  context, so negated phrases ("we do not anticipate losses") score on
  the word, not the sentence.
  Sources: https://onlinelibrary.wiley.com/doi/abs/10.1111/1475-679X.12123 and https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.2010.01625.x
- **Boilerplate swamps signal.** Median 10-K length roughly doubled
  from 23,000 words (1996) to nearly 50,000 (2013), with redundancy,
  boilerplate, and stickiness rising almost monotonically, driven
  largely by fair value, internal controls, and risk-factor
  disclosure requirements. Scoring a whole filing mostly scores
  templated legal language.
  Source: https://www.sciencedirect.com/science/article/abs/pii/S0165410117300484
- **Management tone is managed.** Huang, Teoh, and Zhang (The
  Accounting Review 2014) show abnormal positive tone in earnings
  press releases predicts NEGATIVE future earnings and cash flows and
  clusters around events where managers want perception up (meeting
  thresholds, SEOs, M&A). Positive tone is not good news by itself.
  Source: https://publications.aaahq.org/accounting-review/article/89/3/1083/3532/Tone-Management
- **Analyst speech and Q&A carry more information than prepared
  remarks.** Matsumoto, Pronk, and Roelofsen (The Accounting Review
  2011) find the discussion (Q&A) segment of calls is relatively more
  informative than the presentation segment. This is also why
  Alexandria trains specifically to account for management bias.
  Sources: https://publications.aaahq.org/accounting-review/article/86/4/1383/3354/What-Makes-Conference-Calls-Useful-The-Information and https://insight.factset.com/resources/at-a-glance-alexandria-transcripts
- **The company's own history is the benchmark, not the
  cross-section.** Cohen, Malloy, and Nguyen ("Lazy Prices," Journal
  of Finance 2020) show that CHANGES in a firm's own 10-K/10-Q
  language predict returns (a changers-vs-nonchangers portfolio earns
  up to 188 bps/month), that the informative changes concentrate in
  the MD&A, and that the market underreacts because nobody reads the
  diff. Absolute tone levels differ across industries and writing
  styles; the quarter-over-quarter delta within one company is the
  cleaner signal.
  Sources: https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12885 and https://www.nber.org/papers/w25084

---

## Part 2: Proposal for the Griffin Fund terminal

### What we can and cannot score for free

Earnings-call transcripts are not SEC filings; they never appear on
EDGAR and exist as licensed commercial products (FactSet's own feed is
the example above). Transcripts posted on third-party websites are
those sites' copyrighted content, and ingesting them wholesale is a
licensing problem we should not take on (club judgment, not a sourced
fact). What IS free, on EDGAR, with infrastructure we already have
(`server/src/services/secFilings.js`, `filingDocument.js`,
`secFetch.js`):

- 10-K MD&A (Item 7) and Risk Factors (Item 1A); 10-Q MD&A (Part I
  Item 2) and Risk Factors (Part II Item 1A)
- 8-K bodies, including the earnings press release furnished as
  Exhibit 99.1 under Item 2.02, which is the closest free cousin of
  the call (example filing: https://www.sec.gov/Archives/edgar/data/877860/000087786011000026/form8kearning1q11.htm)
- Club-recorded interview transcripts already in the research module
  (`Interview` rows, MNPI-screened at ingest)

### Design

**Unit and method.** Score per SECTION, like Alexandria, not per
document, because whole-filing scores are boilerplate soup. Two
methods, both stored, never conflated:

1. **Primary: LLM scoring through the existing `llm.js` layer.**
   Chunk each section to fit the local context budget (`contextFor`),
   score each chunk with `llmChat` in `jsonMode` returning
   `{ score: -1..1, confidence, drivers: [..], evidence: [verbatim
   quotes] }`, then aggregate word-count-weighted to a section score.
   Evidence quotes are verified verbatim against the source text
   before storing (the `locateQuote` discipline from claim
   extraction); a quote that does not locate drops. Name the local
   model per call like `RESEARCH_LOCAL_MODEL` does; this is a
   reasoning task and the 7b failure mode is silent.
2. **Baseline: Loughran-McDonald word counts, always available.**
   Pure JS against the free Notre Dame lists
   (https://sraf.nd.edu/loughranmcdonald-master-dictionary/): counts
   of negative, positive, uncertainty, litigious words per section,
   net tone = (pos - neg) / words. No network, cannot be down, and it
   is the industry-standard baseline the LLM score gets sanity-checked
   against. When the LLM is unreachable the panel shows the dictionary
   track and says the model did not run (`modelAvailable:false`
   posture from the MNPI screen; absence is never dressed as a score).

**DB shape (Prisma, new model plus migration):**

```prisma
model SentimentScore {
  id         Int       @id @default(autoincrement())
  ticker     String
  sourceType String    // 'filing' | 'pressRelease' | 'interview'
  sourceKey  String    // accession number or interview id
  section    String    // 'mdna' | 'riskFactors' | 'ex99' | 'full'
  form       String?   // '10-K' | '10-Q' | '8-K'
  periodEnd  DateTime? // fiscal period covered, drives the QoQ series
  filedAt    DateTime?
  method     String    // 'llm' | 'lm'
  model      String?   // model tag when method = 'llm'
  score      Float     // -1.0 .. +1.0 net tone
  confidence Float?
  posCount   Int?      // LM tallies, stored on both method rows
  negCount   Int?
  uncCount   Int?
  litCount   Int?
  wordCount  Int?
  evidence   Json?     // located verbatim quotes (llm rows only)
  createdAt  DateTime  @default(now())

  @@unique([ticker, sourceType, sourceKey, section, method])
  @@index([ticker, periodEnd])
}
```

Section text passes through `storable()` in `artifactText.js` before
any write (the NUL lesson). A filed document is immutable, so a row,
once written, is never recomputed except by explicit backfill.

**When scoring runs.** Lazily on first `SENT <ticker>` open (fetch via
the existing `getFilingDocument` LRU, extract sections with the
`secBusinessSummary.js` header-boundary approach extended to Items 7
and 1A, score, persist), plus a nightly cron alongside the existing
jobs in `index.js` that sweeps HELD tickers for filings newer than
their newest score and pre-warms them. The cron respects the
`secFetch` throttling lessons: sequential, small batch, failures never
cached under a success TTL.

**How deltas surface.** The SENT panel's headline is the change in the
company's own tone, not the level (the Lazy Prices point). Layout
follows the standard panel pattern (fetch via `PanelState` semantics,
loading/failed/empty as distinct renders): a per-section time series
over the last eight-plus periods (LLM track and LM track), a
quarter-over-quarter delta chip per section, the LLM's located
evidence quotes for the newest period, and a plain flag when tone
rose while the LM uncertainty count also rose (the tone-management
asymmetry: abnormal positivity is not good news). Registration is one
entry in `client/src/terminal/registry.js`, a `Sent.jsx` function
component, and a `GET /terminal/sentiment/:ticker` route; the Mac app
ports the panel per the parity rules.

**Build plan.**

- Stage 1 (no LLM dependency): section extractor for Items 7/1A and
  the 10-Q equivalents, LM dictionary module with tests, the
  `SentimentScore` migration, route, and SENT panel with history and
  deltas on the dictionary track.
- Stage 2: LLM scoring through `llmChat` (chunking, aggregation,
  evidence located verbatim), nightly pre-warm cron for holdings,
  both tracks in the panel.
- Stage 3: 8-K/EX-99 press-release stream and watchlist coverage, a
  Lazy Prices style quarter-over-quarter language-change measure on
  the MD&A (similarity, not just tone), and tone on club interview
  transcripts inside FLD (post MNPI screen only).

**What a free build will not match about FactSet.** No licensed call
transcripts at all, so no Q&A vs prepared-remarks split and no
speaker-level scores, which the literature says is where the most
informative tone lives; no 430,000-transcript, 2003-deep,
analyst-corrected corpus; no classifiers trained by professional
analysts; no cross-sectional normalization against an 18,000-company
universe (we can only compare a company against itself, which is
honestly the better signal anyway); no point-in-time guarantee that a
score seen today is the score that existed then (ours begins accruing
only from first scoring); and no event-driven hourly delivery. What we
get instead: the same section-level unit of analysis, the standard
academic baseline plus an LLM read with verifiable quotes, on
documents we are legally allowed to hold, wired into infrastructure
that already exists.
