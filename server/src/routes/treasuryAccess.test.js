import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The ledger and the treasury sleeves are one gate, on the route and
// on the page. A UI that hides the card while the endpoint stays open
// is not a restriction. Director of Public Relations is ranked with
// Chief of Communication, so both have to miss the gate together.

function src(url) {
  return readFileSync(new URL(url, import.meta.url), 'utf8');
}

test('cash balance, the ledger, and cash-yield require a portfolio manager', () => {
  const holdings = src('./holdings.js');
  assert.match(holdings, /router\.get\('\/cash', requireRole\('PortfolioManager'\)/);
  assert.match(holdings, /router\.get\('\/transactions', requireRole\('PortfolioManager'\)/);
  assert.match(holdings, /router\.get\('\/cash-yield', requireRole\('PortfolioManager'\)/);
});

test('the portfolio page puts public relations on the same rank as communications, under the treasury gate', () => {
  const page = src('../../../client/src/pages/Portfolio.jsx');
  assert.match(page, /ChiefOfCommunication: 2/);
  assert.match(page, /DirectorOfPublicRelations: 2/);
  assert.match(
    page,
    /CLIENT_ROLE_RANK\[user\?\.role\] \|\| 0\) >= CLIENT_ROLE_RANK\.PortfolioManager/
  );
});

test('the dashboard does not request treasury detail below that gate', () => {
  const dash = src('../../../client/src/pages/Dashboard.jsx');
  const at = dash.indexOf("'/holdings/cash-yield'");
  assert.ok(at > 0, 'dashboard still knows about cash-yield');
  const window = dash.slice(Math.max(0, at - 280), at);
  assert.match(window, /isPmOrAbove/);
});

test('fieldwork is not a navigation item', () => {
  const side = src('../../../client/src/components/Sidebar.jsx');
  assert.equal(side.includes('/field-research'), false);
  assert.equal(side.includes('Fieldwork'), false);
  // The page stays mounted. Hiding the tab is not deleting the work.
  const app = src('../../../client/src/App.jsx');
  assert.match(app, /path="\/field-research"/);
});

test('isPmOrAbove does not treat the two non-investment offices as portfolio officers', () => {
  const auth = src('../../../client/src/context/AuthContext.jsx');
  const block = auth.slice(auth.indexOf('const isPmOrAbove'), auth.indexOf('const isAnalystOrAbove'));
  assert.match(block, /PortfolioManager/);
  assert.equal(block.includes('DirectorOfPublicRelations'), false);
  assert.equal(block.includes('ChiefOfCommunication'), false);
});
