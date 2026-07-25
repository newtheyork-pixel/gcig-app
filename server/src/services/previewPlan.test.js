import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPlan } from './oneDriveStorage.js';

// previewPlan is the gate between "renders in the pane" and "shows the
// download fallback". Getting it wrong in either direction is a visible
// bug: a false 'passthrough' paints a broken frame, a false
// 'unsupported' tells a member their deck can't be read when it can.

test('PDFs stream through untouched', () => {
  const plan = previewPlan('AIT thesis.pdf');
  assert.equal(plan.mode, 'passthrough');
  assert.equal(plan.contentType, 'application/pdf');
});

test('Office documents route through the PDF conversion', () => {
  for (const name of ['deck.pptx', 'memo.docx', 'model.xlsx', 'old.ppt', 'old.doc']) {
    assert.equal(previewPlan(name).mode, 'convert', name);
    assert.equal(previewPlan(name).contentType, 'application/pdf', name);
  }
});

test('images render natively rather than being converted', () => {
  for (const [name, type] of [
    ['chart.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['shot.webp', 'image/webp'],
  ]) {
    const plan = previewPlan(name);
    assert.equal(plan.mode, 'passthrough', name);
    assert.equal(plan.contentType, type, name);
  }
});

test('archives and unknown binaries are refused up front', () => {
  for (const name of ['bundle.zip', 'data.7z', 'thing.exe', 'noextension']) {
    assert.equal(previewPlan(name).mode, 'unsupported', name);
  }
});

test('extension matching is case-insensitive', () => {
  assert.equal(previewPlan('DECK.PPTX').mode, 'convert');
  assert.equal(previewPlan('Report.PDF').mode, 'passthrough');
});

test('a dotted filename keys off the final extension only', () => {
  assert.equal(previewPlan('2026.Q1.review.pdf').mode, 'passthrough');
  assert.equal(previewPlan('v1.2.deck.pptx').mode, 'convert');
});

test('missing or malformed names degrade to unsupported, not a throw', () => {
  for (const name of [undefined, null, '', '.', 'trailing.']) {
    assert.equal(previewPlan(name).mode, 'unsupported', String(name));
  }
});
