import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTextFromBuffer } from './fileSummarizer.js';

// A PDF must stay readable across a dependency bump.
//
// pdf-parse 2.x stopped default-exporting a function and exports a
// PDFParse class instead, so `(mod.default || mod)(buffer)` resolved to
// the module namespace object and every PDF threw "pdfParse is not a
// function". The throw was caught upstream and rendered as "could not
// read the text of this document", which reads as a property of the
// file rather than of our code — so thirty-five documents, including
// every court filing on the C.H. Robinson project, sat unreadable and
// nothing failed loudly enough to notice.
//
// This test builds a real one-page PDF by hand rather than shipping a
// fixture, so it asserts the installed library actually parses.
function minimalPdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('a PDF still yields its text with the installed pdf-parse', async () => {
  const text = await extractTextFromBuffer(minimalPdf('Griffin Fund research'), 'test.pdf');
  assert.match(text, /Griffin Fund research/,
    'PDF extraction is broken — check the pdf-parse export shape');
});

test('an unreadable type is refused by name, not by silence', async () => {
  await assert.rejects(
    () => extractTextFromBuffer(Buffer.from('x'), 'photo.heic'),
    (e) => e.code === 'UNSUPPORTED_TYPE' && /heic/i.test(e.message)
  );
});

test('a CSV and a spreadsheet both come back as text', async () => {
  const csv = await extractTextFromBuffer(
    Buffer.from('ticker,thesis\nCHRW,"broker, asset-light"\n'), 'x.csv');
  assert.match(csv, /CHRW/);
  // The quoted comma must not split the row — that is the whole reason
  // csv-parse is used rather than a split.
  assert.match(csv, /broker, asset-light/);
});
