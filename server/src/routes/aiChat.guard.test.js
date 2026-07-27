import test from 'node:test';
import assert from 'node:assert/strict';

// The unbacked-price guard, pinned as pure logic.
//
// Live, the assistant said "AIT is trading at $123.45 per share" and
// called it "Advanced Infrastructure Technologies Inc". Both invented —
// the real answer, which it produced correctly on the next attempt, is
// Applied Industrial Technologies at $347.06. A fabricated price handed
// to a member is the worst thing this assistant can do, because someone
// acts on it. Prompting does not make that reliable; this does.
const MONEY = /(?:\$|USD\s?|CHF\s?)(\d[\d,]*(?:\.\d+)?)/gi;
function unbackedPrice(text, fromTools) {
  if (typeof text !== 'string' || fromTools.length === 0) return null;
  const seen = new Set(fromTools.map((n) => String(Number(n))));
  for (const m of text.matchAll(MONEY)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const ok = [...seen].some((v) => {
      const d = Math.abs(Number(v) - n);
      return d < 0.01 || (n !== 0 && d / Math.abs(n) < 0.005);
    });
    if (!ok) return m[0];
  }
  return null;
}

const TOOL = ['347.06', '345.0', '0.6'];

test('a price the tool returned passes', () => {
  assert.equal(unbackedPrice('AIT is trading at $347.06 per share.', TOOL), null);
});

test('a price the tool never returned is caught', () => {
  // The exact live failure.
  assert.equal(unbackedPrice('AIT is trading at $123.45 per share.', TOOL), '$123.45');
});

test('rounding is not fabrication', () => {
  assert.equal(unbackedPrice('about $347 a share', TOOL), null);
  assert.equal(unbackedPrice('$347.06', TOOL), null);
});

test('comma formatting is still matched to the tool value', () => {
  assert.equal(unbackedPrice('CHF 89,463', ['89463']), null);
  assert.equal(unbackedPrice('CHF 89,999', ['89463']), 'CHF 89,999');
});

test('only currency figures are policed', () => {
  // Percentages, dates and counts must pass untouched or the guard
  // would block most ordinary prose.
  assert.equal(unbackedPrice('It rose 0.6% across 17 interviews in 2026.', TOOL), null);
});

test('with no tools run, nothing is policed', () => {
  // A conversation about method that never fetched a quote is not the
  // target; blocking it would make the assistant refuse to discuss
  // valuation at all.
  assert.equal(unbackedPrice('A DCF might value it near $80.', []), null);
});
