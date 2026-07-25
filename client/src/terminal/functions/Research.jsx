import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../../api/client.js';
import PDFModal from '../../components/PDFModal.jsx';

// RSCH — the club's own research, read inside the terminal.
//
// Every research report and pitch deck the Griffin Fund has produced,
// merged into one chronology. Open with a ticker (`AIT RSCH`) to scope
// it to that name, or bare (`RSCH`) for the whole archive with a search
// box.
//
// The panel reads the document itself, not a link to it: the server
// extracts text from the stored PDF/PPTX/DOCX and hands it over with
// whatever AI summary is already cached. That's the point of building
// this into the terminal — our own research stops depending on a
// document viewer rendering correctly, and stays legible next to the
// market data it's about. The original file is always one click away
// for anyone who wants the real artifact.
//
// Two views in one pane rather than side-by-side: a floating window is
// often only ~700px wide, and a two-column split would leave the
// reading column too narrow for prose. Clicking a row swaps to the
// reader; Back returns with the list state intact.

const fmtDate = (d) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${String(dt.getFullYear()).slice(2)}`;
};

// Outcome chips reuse the terminal's semantic colors: a name we bought
// reads positive, one we passed on reads negative. Anything else is
// left neutral rather than guessed at.
const outcomeColor = (o) =>
  o === 'Buy'
    ? 'var(--term-positive)'
    : o === 'NoBuy'
    ? 'var(--term-negative)'
    : 'var(--term-fg-muted)';

// Markdown mapped onto the terminal's palette. The summaries come back
// with `## Thesis` / `## Key Points` section headers, so headings and
// list spacing are what actually matter here.
const MD = {
  h2: ({ children }) => (
    <div
      style={{
        color: 'var(--term-amber, var(--term-white))',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        fontSize: 11,
        marginTop: 12,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  ),
  h1: ({ children }) => MD.h2({ children }),
  h3: ({ children }) => MD.h2({ children }),
  p: ({ children }) => (
    <p style={{ margin: '0 0 8px', lineHeight: 1.55 }}>{children}</p>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>{children}</ul>
  ),
  li: ({ children }) => (
    <li style={{ marginBottom: 3, lineHeight: 1.5 }}>{children}</li>
  ),
  strong: ({ children }) => (
    <strong style={{ color: 'var(--term-white)' }}>{children}</strong>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export default function Research({ ticker }) {
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState(null);
  // Starts true, not false: the fetch effect fires after the first
  // paint, so a false default renders the list branch once with
  // `items` still null.
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  // Free-text filter. Applied client-side against the already-loaded
  // list so typing doesn't fire a request per keystroke — the archive
  // is small enough to hold in memory, and the server's `q` parameter
  // exists for callers that can't.
  const [query, setQuery] = useState('');

  // Which document is open in the reader, plus its loaded body.
  const [openRef, setOpenRef] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docErr, setDocErr] = useState(null);
  const [tab, setTab] = useState('summary');

  // The original file, opened in the shared document modal.
  const [selectedDoc, setSelectedDoc] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setItems(null);
    // A ticker change is a different archive slice — drop whatever
    // reader was open rather than leaving an unrelated document up.
    setOpenRef(null);
    setDoc(null);
    const qs = ticker ? `?ticker=${encodeURIComponent(ticker)}` : '';
    api
      .get(`/terminal/research${qs}`)
      .then(({ data }) => {
        if (cancelled) return;
        setItems(data.items || []);
        setCounts(data.counts || null);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e.response?.data?.error || e.message || 'Failed to load');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    if (!openRef) return undefined;
    let cancelled = false;
    setDocLoading(true);
    setDocErr(null);
    setDoc(null);
    api
      .get(`/terminal/research/${encodeURIComponent(openRef)}`)
      .then(({ data }) => {
        if (cancelled) return;
        setDoc(data);
        // Land on whichever view actually has something in it. A
        // document with no cached summary should open on its text
        // rather than an empty pane with a "generate" prompt.
        setTab(data.summary ? 'summary' : 'text');
      })
      .catch((e) => {
        if (!cancelled) {
          setDocErr(e.response?.data?.error || e.message || 'Failed to open');
        }
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openRef]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((it) =>
      [it.title, it.author, it.ticker, it.description, it.industry]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle))
    );
  }, [items, query]);

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">
          Loading internal research{ticker ? ` for ${ticker.toUpperCase()}` : ''}…
        </div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }

  if (openRef) {
    return (
      <ReaderView
        doc={doc}
        loading={docLoading}
        err={docErr}
        tab={tab}
        setTab={setTab}
        onBack={() => setOpenRef(null)}
        onOpenFile={setSelectedDoc}
        selectedDoc={selectedDoc}
        onCloseFile={() => setSelectedDoc(null)}
      />
    );
  }

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        {ticker ? <span className="ticker">{ticker.toUpperCase()}</span> : null}
        <span className="name">Internal Research</span>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by title, author, ticker, industry…"
        spellCheck={false}
        style={{
          width: '100%',
          background: 'var(--term-bg, #000)',
          color: 'var(--term-white)',
          border: '1px solid var(--term-border)',
          padding: '6px 10px',
          fontFamily: 'inherit',
          fontSize: 12,
          outline: 'none',
        }}
      />

      {filtered.length === 0 ? (
        <div className="term-loading">
          {!items || items.length === 0
            ? ticker
              ? `No internal research on ${ticker.toUpperCase()} yet.`
              : 'The research archive is empty.'
            : `Nothing matches "${query}".`}
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Sym</th>
              <th>Document</th>
              <th>Author</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((it) => (
              <tr key={it.id}>
                <td>{fmtDate(it.date)}</td>
                <td className="sym">{it.ticker || '—'}</td>
                <td>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setOpenRef(it.id);
                    }}
                    title="Read in the terminal"
                  >
                    {it.title}
                  </a>
                  {it.outcome ? (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        color: outcomeColor(it.outcome),
                      }}
                    >
                      {it.outcome === 'NoBuy' ? 'PASSED' : 'BOUGHT'}
                    </span>
                  ) : null}
                </td>
                <td>{it.author || '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {/* Tell the reader what they're walking into: an AI
                      read already exists, or there's no file at all. */}
                  {!it.fileRef ? (
                    <span style={{ fontSize: 10, color: 'var(--term-fg-muted)' }}>
                      NO FILE
                    </span>
                  ) : it.hasSummary ? (
                    <span style={{ fontSize: 10, color: 'var(--term-fg-dim)' }}>
                      AI
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        {counts
          ? `${counts.reports} report${counts.reports === 1 ? '' : 's'} · ${counts.pitches} pitch deck${counts.pitches === 1 ? '' : 's'}`
          : ''}
        {ticker ? ' · scoped to this ticker' : ' · whole archive'} · click a
        row to read it here. AI marks a cached summary.
      </div>
    </div>
  );
}

function ReaderView({
  doc,
  loading,
  err,
  tab,
  setTab,
  onBack,
  onOpenFile,
  selectedDoc,
  onCloseFile,
}) {
  const backBtn = (
    <button
      type="button"
      onClick={onBack}
      className="term-btn"
      style={{
        background: 'transparent',
        color: 'var(--term-fg-dim)',
        border: '1px solid var(--term-border)',
        padding: '3px 10px',
        fontFamily: 'inherit',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        cursor: 'pointer',
      }}
    >
      ← Archive
    </button>
  );

  if (loading) {
    return (
      <div className="term-panel">
        {backBtn}
        <div className="term-loading">Reading document…</div>
      </div>
    );
  }
  if (err || !doc) {
    return (
      <div className="term-panel">
        {backBtn}
        <div className="term-error">Error: {err || 'Nothing to show'}</div>
      </div>
    );
  }

  const hasText = !!doc.text;
  const canOpenFile = !!doc.fileRef;

  return (
    <div className="term-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        {backBtn}
        {canOpenFile ? (
          <button
            type="button"
            onClick={() => onOpenFile({ url: doc.fileRef, title: doc.title })}
            className="term-btn"
            style={{
              background: 'transparent',
              color: 'var(--term-white)',
              border: '1px solid var(--term-border)',
              padding: '3px 10px',
              fontFamily: 'inherit',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              cursor: 'pointer',
            }}
          >
            Open document
          </button>
        ) : null}
      </div>

      <div className="term-panel-header">
        {doc.ticker ? <span className="ticker">{doc.ticker}</span> : null}
        <span className="name">{doc.title}</span>
      </div>

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        {[
          doc.author,
          fmtDate(doc.date),
          doc.kind === 'pitch' ? 'Pitch deck' : 'Research report',
          doc.industry,
        ]
          .filter(Boolean)
          .join(' · ')}
        {doc.outcome ? (
          <span style={{ marginLeft: 6, color: outcomeColor(doc.outcome) }}>
            · {doc.outcome === 'NoBuy' ? 'Club passed' : 'Club bought'}
          </span>
        ) : null}
      </div>

      {doc.description ? (
        <div style={{ color: 'var(--term-fg-dim)', fontSize: 12 }}>
          {doc.description}
        </div>
      ) : null}

      {/* Whatever kept us from reading the bytes — an external link, a
          missing upload, an image-only PDF. Said plainly, because a
          silent empty pane reads as "no research exists". */}
      {doc.unavailable ? (
        <div className="term-error">{doc.unavailable}</div>
      ) : null}

      {doc.summary || hasText ? (
        <>
          <div className="term-tabs">
            {doc.summary ? (
              <button
                type="button"
                className={`term-tab${tab === 'summary' ? ' active' : ''}`}
                onClick={() => setTab('summary')}
              >
                AI Summary
              </button>
            ) : null}
            {hasText ? (
              <button
                type="button"
                className={`term-tab${tab === 'text' ? ' active' : ''}`}
                onClick={() => setTab('text')}
              >
                Full Text
              </button>
            ) : null}
          </div>

          {tab === 'summary' && doc.summary ? (
            <div
              className="term-ai-block"
              style={{ fontSize: 12, lineHeight: 1.55 }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
                {doc.summary}
              </ReactMarkdown>
              <div
                style={{
                  marginTop: 10,
                  color: 'var(--term-fg-muted)',
                  fontSize: 10,
                }}
              >
                AI summary of the document
                {doc.summaryModel ? ` · ${doc.summaryModel}` : ''} — read the
                full text for anything you intend to cite.
              </div>
            </div>
          ) : null}

          {tab === 'text' && hasText ? (
            <>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: 'var(--term-fg-dim)',
                  margin: 0,
                  maxHeight: '52vh',
                  overflowY: 'auto',
                  border: '1px solid var(--term-border)',
                  padding: '10px 12px',
                }}
              >
                {doc.text}
              </pre>
              <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
                {doc.chars != null
                  ? `${doc.chars.toLocaleString()} characters extracted`
                  : 'Extracted text'}
                {doc.truncated
                  ? ' · truncated for display — open the document for the rest'
                  : ''}
              </div>
            </>
          ) : null}
        </>
      ) : !doc.unavailable ? (
        <div className="term-loading">
          Nothing readable in this document yet.
        </div>
      ) : null}

      <PDFModal
        url={selectedDoc?.url}
        title={selectedDoc?.title}
        onClose={onCloseFile}
      />
    </div>
  );
}
