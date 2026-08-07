import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBio } from './filingBio.js';

// The fixture is the real paragraph from Apple's January 2025 8-K
// announcing the CFO transition, trimmed. The signature page and the
// compensation-table narrative are the two lookalikes that must lose.
const APPOINTMENT = `
<p>As part of Apple Inc.&#8217;s (&#8220;Apple&#8217;s&#8221;) previously announced Chief Financial Officer transition plan, Apple&#8217;s Board of Directors appointed Kevan Parekh, 53, as Apple&#8217;s Senior Vice President, Chief Financial Officer, effective January 1, 2025. Mr. Parekh joined Apple in June 2013 and assumed his current position in January 2025. Mr. Parekh&#8217;s previous positions at Apple include Vice President, Financial Planning and Analysis. Prior to joining Apple, Mr. Parekh held various senior leadership roles at Thomson Reuters and General Motors.</p>`;

const SIGNATURE = `
<p>Pursuant to the requirements of the Securities Exchange Act of 1934, the Registrant has duly caused this report to be signed on its behalf by the undersigned hereunto duly authorized. Date: December 5, 2025 Apple Inc. By: /s/ Kevan Parekh Kevan Parekh Senior Vice President, Chief Financial Officer and some more boilerplate to cross the length floor for the test to be honest about why the block is rejected rather than merely short.</p>`;

const COMP_TABLE = `
<p>The grant date fair value of the performance-based RSUs granted to Mr. Maestri, Ms. Adams, and Mr. Williams in 2019 was previously reported and such RSUs vest based on total shareholder return over the performance period, as served by the compensation committee and described in the proxy under the heading titled equity awards, with additional narrative that names each officer repeatedly without ever describing who they are.</p>`;

test('the appointment paragraph wins', () => {
  const bio = extractBio(APPOINTMENT + SIGNATURE, 'Kevan Parekh');
  assert.ok(bio);
  assert.match(bio, /joined Apple in June 2013/);
  assert.match(bio, /Thomson Reuters/);
});

test('a signature page alone yields nothing', () => {
  assert.equal(extractBio(SIGNATURE, 'Kevan Parekh'), null);
});

test('compensation-table narrative is rejected', () => {
  assert.equal(extractBio(COMP_TABLE, 'Katherine Adams'), null);
});

test('a document about somebody else yields nothing', () => {
  assert.equal(extractBio(APPOINTMENT, 'Jane Nowhere'), null);
});

test('a successor announcement is not the departing officer’s bio', () => {
  const NEWSTEAD = `
<p>On December 4, 2025, Apple Inc. ("Apple") announced that Jennifer Newstead will become Apple's General Counsel, succeeding Katherine Adams. Ms. Adams, who previously announced her intention to retire, served Apple since 2017. Ms. Adams will continue in an advisory role during the transition period to support continuity across the legal organization.</p>`;
  assert.equal(extractBio(NEWSTEAD, 'Katherine Adams'), null);
  const forNewstead = extractBio(NEWSTEAD, 'Jennifer Newstead');
  assert.ok(forNewstead === null || /Newstead will become/.test(forNewstead));
});
