import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mentionsSegLabel,
  projectCarriesSegLabel,
  withoutSegProjects,
  stripSegLabels,
  claimCarriesSegLabel,
} from './segLabel.js';

test('the historical-file titles match, and ordinary words do not', () => {
  for (const title of [
    'Align Technology — SEG historical file',
    'Lowes — SEG historical file',
    'Mesa Labs — SEG historical file',
    'SEG',
    'seg historical file',
    'Notes, SEG.',
  ]) {
    assert.equal(mentionsSegLabel(title), true, title);
  }
  for (const clean of [
    null,
    '',
    'segment',
    'Segment operates plants nearby',
    'SEGMENT',
    'seg13f',
    'Select Equity',
    'preSEG',
    'Lindt & Sprüngli — 2026 field study',
    'Costco membership fee',
  ]) {
    assert.equal(mentionsSegLabel(clean), false, String(clean));
  }
});

test('a project is hidden from its identity fields, not from its ticker', () => {
  assert.equal(projectCarriesSegLabel({
    name: 'Align Technology — SEG historical file',
    ticker: 'ALGN',
    status: 'Closed',
  }), true);
  assert.equal(projectCarriesSegLabel({
    name: 'Lindt field study',
    brief: 'What the SEG archive said about the aisle',
  }), true);
  assert.equal(projectCarriesSegLabel({
    name: 'A retired duplicate',
    ticker: 'MLAB',
    status: 'Closed',
    folder: null,
  }), false);
  // A symbol is not the label. Hiding it would take a holding off the book.
  assert.equal(projectCarriesSegLabel({ name: 'Some company', ticker: 'SEG' }), false);
});

test('the list keeps closed work that does not carry the label', () => {
  const rows = withoutSegProjects([
    { name: 'Align Technology — SEG historical file', status: 'Closed' },
    { name: 'Lindt & Sprüngli — 2026 field study', status: 'Closed' },
    { name: 'Costco membership fee', status: 'Fieldwork' },
    { name: 'Mesa Labs — retired duplicate', status: 'Closed' },
  ]);
  assert.deepEqual(rows.map((p) => p.name), [
    'Lindt & Sprüngli — 2026 field study',
    'Costco membership fee',
    'Mesa Labs — retired duplicate',
  ]);
});

test('a labeled project is withheld whole, including from a direct open', () => {
  assert.equal(stripSegLabels({ name: 'Lowes — SEG historical file', brief: 'archive' }), null);
  assert.equal(stripSegLabels(null), null);
});

test('a kept project loses only the children whose labels carry it', () => {
  const project = stripSegLabels({
    name: 'Signet channel checks',
    brief: 'What is on the counter',
    artifacts: [
      { title: 'Store notes', filename: 'notes.pdf' },
      { title: 'SEG historical file', filename: 'archive.pdf' },
    ],
    interviews: [
      { title: 'Kay — manager' },
      { title: 'SEG intro call' },
    ],
    questions: [{ text: 'Is the case full?' }, { text: 'What did SEG file?' }],
    visits: [{
      location: 'Short Hills',
      siteObservations: [{ text: 'The segment by the door was full' }, { text: 'SEG placard' }],
    }],
    targets: [{
      name: 'Store manager',
      drafts: [{ subject: 'Introduction', body: 'Hello' }, { subject: 'SEG follow up', body: 'Hello' }],
      messages: [{ subject: 'Re: visit', body: 'Thanks' }],
    }],
  });
  assert.equal(project.artifacts.length, 1);
  assert.equal(project.artifacts[0].title, 'Store notes');
  assert.equal(project.interviews.length, 1);
  assert.equal(project.questions.length, 1);
  assert.equal(project.questions[0].text, 'Is the case full?');
  assert.equal(project.visits[0].siteObservations.length, 1);
  assert.match(project.visits[0].siteObservations[0].text, /segment/);
  assert.equal(project.targets[0].drafts.length, 1);
  assert.equal(project.targets[0].drafts[0].subject, 'Introduction');
});

test('a claim that states the label does not ship with the project', () => {
  assert.equal(claimCarriesSegLabel({ text: 'The case was full', quote: 'pretty full' }), false);
  assert.equal(claimCarriesSegLabel({ text: 'SEG owns the relationship', quote: 'pretty full' }), true);
  assert.equal(claimCarriesSegLabel({ text: 'Fine', quote: 'the segment was fine' }), false);
});

test('every member-facing project read drops the label, including the super admin', () => {
  // ownerOnly still renders for that account. The filter has to be its
  // own check, on each read, or Fieldwork keeps the rows for the person
  // who asked them gone.
  const files = [
    '../routes/research.js',
    '../routes/holdings.js',
    '../routes/dav.js',
    '../routes/calls.js',
    '../ai/researchContext.js',
    '../services/buyLevelWatch.js',
    '../services/internalResearch.js',
    '../routes/reports.js',
    '../routes/dashboard.js',
    '../routes/pitches.js',
    '../routes/events.js',
    '../routes/users.js',
  ];
  for (const file of files) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(
      src,
      /projectCarriesSegLabel|withoutSegProjects|stripSegLabels|mentionsSegLabel/,
      file,
    );
  }
});
