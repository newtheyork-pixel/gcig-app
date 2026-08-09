import test from 'node:test';
import assert from 'node:assert/strict';
import { screenOutreach, keywordScreen, SYSTEM_PROMPT, RISK } from './outreachScreen.js';

// Four real drafts that came back "elevated" with the keyword pass
// completely clean, meaning the model raised them on its own — and every
// one sits squarely inside the prompt's own "Do NOT flag" list. Two ask
// former PetSmart executives how their own job worked while they were
// there; two ask a jewellery buying group what has happened to the average
// bridal sale across their membership. A screen that fires on writing this
// careful is how a flag becomes noise people click past, which costs more
// than the miss it prevents. These guard against a future prompt edit
// silently walking the calibration back.

const PETSMART_1 = {
  subject: 'Your time leading merchandising at PetSmart',
  body:
    "I'm a student with the Griffin Fund, the investment club at Grace Church " +
    'School, and we manage part of the school endowment as a learning project. ' +
    'This is unpaid and nothing commercial. I would love to understand how the ' +
    'private-label buying process worked while you were there: how a new food ' +
    'line got from idea to shelf, and who signed off. We are only asking about ' +
    'how your own job worked during your time there, not about anything at the ' +
    'company today. Thank you for considering it.',
};

const PETSMART_2 = {
  subject: 'How store operations worked during your years at PetSmart',
  body:
    "I'm with the Griffin Fund investment club at Grace Church School; we run a " +
    'slice of the school endowment as students and this outreach is unpaid. I am ' +
    'trying to understand how your job actually worked while you were there, ' +
    'specifically how a regional manager balanced payroll hours against service. ' +
    'We are only asking about your own experience during your time there, nothing ' +
    'confidential and nothing about the business today. Grateful for anything you ' +
    'can share.',
};

const JEWELLERY_1 = {
  subject: "Trends across your buying group's membership",
  body:
    "I'm a student researcher with the Griffin Fund, the investment club at Grace " +
    'Church School, and we invest part of the school endowment. This is unpaid and ' +
    'nothing commercial. We are studying the bridal jewellery market and would ' +
    'value your read on what has happened to the average bridal sale across your ' +
    'membership over the past few years, whether tickets have risen or fallen and ' +
    'how the mix has shifted. We are only asking about broad, already public ' +
    'industry trends, nothing confidential to any single store. Thanks so much.',
};

const JEWELLERY_2 = {
  subject: 'The average bridal ticket across your co-op',
  body:
    'Writing from the Griffin Fund investment club at Grace Church School, where ' +
    'students manage a portion of the endowment; this note is unpaid. Across the ' +
    'retailers in your group, what has become of the typical engagement-ring sale ' +
    'in recent years, is the average ticket up or down, and are couples trading up ' +
    'or down on stones? We are only asking about the general direction of the ' +
    "category, information that is already public, nothing about any one member's " +
    'own business. Appreciate your time.',
};

const CLEAN = [
  { draft: PETSMART_1, target: { name: 'A. Rivera', relationship: 'FormerEmployee', employer: 'Retired' } },
  { draft: PETSMART_2, target: { name: 'B. Okafor', relationship: 'FormerEmployee', employer: 'Retired' } },
  { draft: JEWELLERY_1, target: { name: 'C. Lindqvist', relationship: 'IndustryContact', employer: 'Bridal Buying Group' } },
  { draft: JEWELLERY_2, target: { name: 'D. Marchetti', relationship: 'IndustryContact', employer: 'Jewellers Co-op' } },
];

const compose = (d) => `Subject: ${d.subject}\n\n${d.body}`;

test('the four drafts leave the keyword pass completely clean', () => {
  // The premise of the bug: nothing deterministic fired, so anything above
  // low can only be the model's own judgment.
  for (const { draft } of CLEAN) {
    const hits = keywordScreen(compose(draft));
    assert.equal(hits.length, 0, `keyword pass should be clean for "${draft.subject}": ${JSON.stringify(hits)}`);
  }
});

test('a clean, well-bounded draft the model reads correctly returns low', async () => {
  // With no keyword hits and no current-employee relationship, the only
  // thing that could raise these is the model. A correctly calibrated model
  // returns low, and the screen must pass that through unchanged.
  const llmChat = async () =>
    JSON.stringify({ risk: 'low', reason: 'Former employee asked about their own past role' });
  for (const { draft, target } of CLEAN) {
    const r = await screenOutreach(draft, target, { llmChat });
    assert.equal(r.risk, RISK.LOW, `expected low for "${draft.subject}"`);
    assert.equal(r.modelAvailable, true);
  }
});

test('the prompt tells the model that flagging has a cost', () => {
  // The over-flagging lives in the model's judgment, so a synthetic test
  // cannot exercise it directly. What it can do is pin the three principles
  // to the prompt text, so an edit that drops the low default, the binding
  // do-not-flag rule, or the name-your-category requirement fails here
  // rather than in a stranger's inbox.
  assert.match(SYSTEM_PROMPT, /should return low/, 'states the low default');
  assert.match(SYSTEM_PROMPT, /not a hedge/, 'names the cost of an unnecessary flag');
  assert.match(SYSTEM_PROMPT, /return low unless/, 'the do-not-flag list is binding, not advisory');
  assert.match(SYSTEM_PROMPT, /absence of a reason to flag is a reason to return low/i);
  assert.match(SYSTEM_PROMPT, /must identify the specific behaviour/i, 'a flag must name its category');
  assert.match(SYSTEM_PROMPT, /cannot name one, return low/i);
});

test('the do-not-flag categories covering these four cases stay in the prompt', () => {
  // Delete either bullet and the PetSmart drafts or the jewellery drafts are
  // no longer covered by name.
  assert.match(SYSTEM_PROMPT, /FORMER employee how their job worked while they were there/);
  assert.match(SYSTEM_PROMPT, /industry conditions, competitors, or generally observable trends/);
});

test('the fix does not weaken the pessimistic combine: the model still raises', async () => {
  // Calibrating toward low is only the model's own judgment. The combine is
  // untouched — the model may raise, never lower.
  const llmChat = async () =>
    JSON.stringify({ risk: 'prohibited', reason: 'Asks a sitting executive about that company operations' });
  const r = await screenOutreach(PETSMART_1, { relationship: 'FormerEmployee' }, { llmChat });
  assert.equal(r.risk, RISK.PROHIBITED);
});
