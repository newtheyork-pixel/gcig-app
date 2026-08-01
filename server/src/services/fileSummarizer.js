import prisma from '../db.js';
import { llmChat } from './llm.js';
import { getAccessToken } from './oneDriveStorage.js';

// AI summarization for uploaded files. Flow:
//   1. Fetch the file bytes from OneDrive via Graph (auth handled by
//      the oneDriveStorage service — same access token the upload path
//      uses).
//   2. Extract text with pdf-parse (PDF only for now — other types
//      fall through to a helpful "unsupported" error).
//   3. Cap the text at MAX_CHARS so we stay well inside the local
//      Ollama model's context window, then send to llmChat with a
//      pitch-club-tuned system prompt.
//   4. Persist the result to FileSummary keyed by fileRef so repeat
//      opens read from the DB instead of burning GPU cycles.
//
// Regeneration is available via summarizeFile(itemId, { force: true }).

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ~40K chars ≈ 10K tokens. Leaves plenty of headroom for the system
// prompt + a detailed response inside qwen2.5:14b's context window.
const MAX_CHARS = 40_000;

const SYSTEM_PROMPT = `You are summarizing a document for members of The Griffin Fund, a student-run investment club at Grace Church School. Documents are typically pitch decks, research reports, or financial analyses; occasionally they are meeting minutes or general notes.

Produce a concise summary with this structure, using the exact section headers. Use markdown.

## Thesis
2–3 sentences on the core idea of the document. If it's a pitch/report, the investment thesis. Otherwise, the main topic.

## Key Points
3–5 bullet points covering the most important claims, findings, or conclusions. Be specific — prefer concrete figures and named drivers over generic "positive outlook" language.

## Risks & Caveats
2–4 bullet points on downside scenarios, counterarguments, or limitations named in the doc. If nothing is named, write "None explicitly named in the document." Do not invent risks not mentioned.

## Numbers
Any specific figures that appear — revenue, margins, price targets, dates, allocation sizes. One per line, in the format "**Label:** value". If none, omit this section entirely.

Constraints:
- Stick to what's in the document. Do NOT add external market commentary, industry trivia, or opinions.
- If a section would be empty, omit it entirely (except Risks, which always gets the "none named" note).
- Keep total output under 400 words.
- Plain prose inside each bullet — no nested lists.`;

// Pull the raw bytes for a OneDrive item. Uses the shared access
// token (refreshed on demand) that the rest of oneDriveStorage uses.
async function fetchBuffer(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fetch file bytes failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function fetchItemMetadata(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Metadata fetch failed (${res.status})`);
  return res.json();
}

// ── Text extraction ─────────────────────────────────────────────────
// PPTX / DOCX are ZIP archives with XML inside. Rather than pulling
// in a heavy Office-doc library, we unzip with jszip and pull text
// from the well-defined text-run tags with a light regex. That
// catches ~99% of real documents — slightly-malformed or image-only
// slides are silently skipped, which is the right behavior.

// Unescape the XML entities that show up in real text.
//
// Numeric forms matter as much as the named ones and were missing:
// Office writes an umlaut as &#252;, so "Lindt & Spr&#252;ngli" came
// out of a real workbook with the escape sitting in the middle of the
// company's name. Ampersand is unescaped LAST, so an escaped &amp;lt;
// does not become a live tag on the way through.
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Pull `<TAG>...</TAG>` bodies out of XML, in document order.
// self-closing `<TAG/>` tags are ignored (they carry no text).
function extractTagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const decoded = decodeXmlEntities(m[1]).trim();
    if (decoded) out.push(decoded);
  }
  return out;
}

async function extractPptxText(buffer) {
  const JSZipModule = await import('jszip');
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = await JSZip.loadAsync(buffer);
  // Slide files live at ppt/slides/slide<N>.xml. Sort by number so
  // the extracted text reads slide-1-first.
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)[1]);
      const nb = Number(b.match(/slide(\d+)/)[1]);
      return na - nb;
    });
  if (slideFiles.length === 0) {
    throw new Error('PPTX has no slides — file may be corrupt.');
  }
  const parts = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i]).async('string');
    // <a:t> is the DrawingML text-run element used across slides.
    const runs = extractTagText(xml, 'a:t');
    if (runs.length === 0) continue;
    parts.push(`--- Slide ${i + 1} ---\n${runs.join('\n')}`);
  }
  return parts.join('\n\n').trim();
}

async function extractDocxText(buffer) {
  const JSZipModule = await import('jszip');
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) {
    throw new Error('DOCX has no document.xml — file may be corrupt.');
  }
  const xml = await file.async('string');
  // <w:t> is WordprocessingML's text-run element. <w:p> paragraphs
  // get a newline separator so the output reads like the source doc.
  const paragraphs = xml.split(/<\/w:p>/);
  const out = [];
  for (const p of paragraphs) {
    const runs = extractTagText(p, 'w:t');
    if (runs.length > 0) out.push(runs.join(''));
  }
  return out.join('\n').trim();
}


/// A spreadsheet, read as text.
///
/// Two things a first draft got wrong against real workbooks from this
/// user's own files, both caught by running it rather than reasoning
/// about it:
///
///   Not every workbook has xl/sharedStrings.xml. The Lindt model has
///   none at all and writes every label inline as `t="inlineStr"` with
///   `<is><t>`, so a reader that only follows shared strings returns a
///   sheet of numbers with no headings.
///
///   The relationship file does not fix its attribute order. One
///   workbook writes Id before Target and another writes Type, Target,
///   Id — so a single regex expecting a fixed order resolved zero
///   sheets on half the corpus. Id and Target are read independently.
///
/// Number formats live in xl/styles.xml, which this does not read, so a
/// date arrives as its serial number. That is acceptable for reading and
/// searching prose; it is not a date index, and nothing should present
/// it as one.

/// PDF text, through whichever pdf-parse API is installed.
///
/// This was silently broken. pdf-parse 2.x stopped default-exporting a
/// function and exports a `PDFParse` CLASS, so
/// `(module.default || module)(buffer)` resolved to the module
/// namespace object and every PDF threw "pdfParse is not a function".
/// The throw was caught and rendered as "could not read the text of
/// this document", so it looked like a property of the files rather
/// than of our code — and it stayed that way through a dependency bump
/// because nothing asserted a PDF could still be read. Thirty-five
/// documents, including every court filing on the C.H. Robinson
/// project, had no readable text for that reason alone.
///
/// Both shapes are handled: a downgrade should not break it a second
/// time in the other direction.
async function extractPdfText(buffer) {
  const mod = await import('pdf-parse');
  if (typeof mod.PDFParse === 'function') {
    const parser = new mod.PDFParse({ data: buffer });
    try {
      const out = await parser.getText();
      return String(out?.text || '').trim();
    } finally {
      if (typeof parser.destroy === 'function') await parser.destroy();
    }
  }
  const legacy = mod.default || mod;
  if (typeof legacy !== 'function') {
    throw new Error('pdf-parse exposes neither PDFParse nor a callable default.');
  }
  const data = await legacy(buffer);
  return String(data?.text || '').trim();
}

async function extractXlsxText(buffer) {
  const JSZipModule = await import('jszip');
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = await JSZip.loadAsync(buffer);

  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = [];
  if (sharedFile) {
    const xml = await sharedFile.async('string');
    // One <si> is one string, and it may be split across several runs.
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(extractTagText(m[1], 't').join(''));
    }
  }

  // Sheet name -> file, via the workbook's relationships.
  const names = new Map();
  const wb = zip.file('xl/workbook.xml');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const relXml = await rels.async('string');
    const target = new Map();
    for (const m of relXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
      const id = (m[1].match(/\bId="([^"]+)"/) || [])[1];
      const t = (m[1].match(/\bTarget="([^"]+)"/) || [])[1];
      if (id && t) target.set(id, t.replace(/^\/?xl\//, ''));
    }
    const wbXml = await wb.async('string');
    for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
      const nm = (m[1].match(/\bname="([^"]+)"/) || [])[1];
      const rid = (m[1].match(/r:id="([^"]+)"/) || [])[1];
      if (nm && rid && target.has(rid)) names.set(`xl/${target.get(rid)}`, decodeXmlEntities(nm));
    }
  }

  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();

  const out = [];
  for (const path of sheetPaths) {
    const xml = await zip.file(path).async('string');
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const type = (cm[1].match(/\bt="([^"]+)"/) || [])[1];
        if (type === 's') {
          const idx = Number(extractTagText(cm[2], 'v')[0]);
          if (Number.isInteger(idx) && shared[idx]) cells.push(decodeXmlEntities(shared[idx]));
        } else if (type === 'inlineStr') {
          const t = extractTagText(cm[2], 't').join('');
          if (t) cells.push(t);
        } else {
          const v = extractTagText(cm[2], 'v')[0];
          if (v) cells.push(decodeXmlEntities(v));
        }
      }
      if (cells.length) rows.push(cells.join('\t'));
    }
    if (rows.length) {
      const title = names.get(path) || path.split('/').pop().replace('.xml', '');
      out.push(`# ${title}\n${rows.join('\n')}`);
    }
  }
  return out.join('\n\n').trim();
}

/// A CSV, flattened to tab-separated lines. csv-parse is already a
/// dependency and handles the quoting rules a split on commas does not.
async function extractCsvText(buffer) {
  const { parse } = await import('csv-parse/sync');
  const rows = parse(buffer.toString('utf8'), {
    relax_column_count: true,
    skip_empty_lines: true,
    relax_quotes: true,
    bom: true,
  });
  return rows.map((r) => r.join('\t')).join('\n').trim();
}

async function extractText(buffer, filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) {
    return extractPdfText(buffer);
  }
  if (lower.endsWith('.pptx')) {
    return extractPptxText(buffer);
  }
  if (lower.endsWith('.docx')) {
    return extractDocxText(buffer);
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    return extractXlsxText(buffer);
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    return extractCsvText(buffer);
  }
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json')) {
    return buffer.toString('utf8').trim();
  }
  const err = new Error(
    'Readable types are PDF, DOCX, PPTX, XLSX, CSV, TXT, MD and JSON — '
    + `got ${filename || 'an unknown type'}.`
  );
  err.code = 'UNSUPPORTED_TYPE';
  throw err;
}

// Extracted text, memoized. The terminal's research reader pulls the
// same document repeatedly as members scroll and reopen it, and each
// miss costs a Graph download plus a full PDF parse. Uploaded files are
// immutable, so a cache entry is never stale — the only reason to bound
// it is memory. Keep the last few documents; the map is small (a big
// deck extracts to well under a megabyte of text).
const TEXT_CACHE = new Map();
const TEXT_CACHE_MAX = 12;

/**
 * Pull the readable text out of a OneDrive-hosted document.
 *
 * Throws with `code = 'UNSUPPORTED_TYPE'` for formats we can't parse
 * (images, archives) so callers can say so instead of showing an empty
 * pane.
 *
 * @param {string} itemId - OneDrive item id
 * @returns {Promise<{text: string, filename: string|null, chars: number}>}
 */
export async function extractFileText(itemId) {
  const hit = TEXT_CACHE.get(itemId);
  if (hit) {
    // Refresh recency — Map preserves insertion order, so delete+set
    // moves this entry to the back of the eviction queue.
    TEXT_CACHE.delete(itemId);
    TEXT_CACHE.set(itemId, hit);
    return hit;
  }

  const meta = await fetchItemMetadata(itemId);
  const buffer = await fetchBuffer(itemId);
  const text = await extractText(buffer, meta.name);
  const result = {
    text,
    filename: meta.name || null,
    chars: text.length,
  };

  TEXT_CACHE.set(itemId, result);
  if (TEXT_CACHE.size > TEXT_CACHE_MAX) {
    TEXT_CACHE.delete(TEXT_CACHE.keys().next().value);
  }
  return result;
}

/**
 * Generate (or fetch cached) an AI summary for a OneDrive-hosted
 * file. Returns the full FileSummary row.
 *
 * @param {string} itemId - OneDrive item id (without any scheme prefix)
 * @param {object} opts
 * @param {boolean} opts.force - Regenerate even if a row exists
 */
export async function summarizeFile(itemId, { force = false } = {}) {
  const fileRef = `onedrive:${itemId}`;

  if (!force) {
    const existing = await prisma.fileSummary.findUnique({ where: { fileRef } });
    if (existing) return existing;
  }

  const meta = await fetchItemMetadata(itemId);
  const buffer = await fetchBuffer(itemId);
  const text = await extractText(buffer, meta.name);
  if (!text || text.length < 100) {
    throw new Error(
      `Extracted too little text (${text.length} chars) — the document may be image-only or empty.`
    );
  }

  const truncated = text.length > MAX_CHARS;
  const input = truncated ? text.slice(0, MAX_CHARS) : text;
  const userMsg = truncated
    ? `[Note: document is ${text.length.toLocaleString()} chars; summarizing the first ${MAX_CHARS.toLocaleString()} chars — about the opening portion. Acknowledge at the end if that limits your read.]\n\n${input}`
    : input;

  const summary = await llmChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.3,
  });
  if (!summary) {
    throw new Error('LLM returned no content — check local Ollama / OpenAI fallback.');
  }

  const modelTag = process.env.LOCAL_LLM_URL ? 'local' : 'openai';

  return prisma.fileSummary.upsert({
    where: { fileRef },
    create: {
      fileRef,
      filename: meta.name || null,
      summary,
      model: modelTag,
      charCount: text.length,
      truncated,
    },
    update: {
      filename: meta.name || null,
      summary,
      model: modelTag,
      charCount: text.length,
      truncated,
    },
  });
}

export async function getCachedSummary(itemId) {
  const fileRef = `onedrive:${itemId}`;
  return prisma.fileSummary.findUnique({ where: { fileRef } });
}

/// Buffer-level entry point.
///
/// `extractFileText` asks Graph for the filename before it can pick a
/// parser. A caller that already knows it — the backfill reads it off
/// the artifact row — should not pay for that round trip, which halves
/// the Graph calls per file from two to one.
export async function extractTextFromBuffer(buffer, filename) {
  return extractText(buffer, filename);
}
