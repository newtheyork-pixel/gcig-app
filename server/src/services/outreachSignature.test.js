import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureFor } from './outreachSignature.js';

// A missing title falls through to "Analyst", which is how a scheduled
// letter once left signed without an office. The public-relations
// director has to sign as that office.
test('a public-relations director signs with the office', () => {
  const block = signatureFor({
    name: 'Ada Member',
    role: 'DirectorOfPublicRelations',
    email: 'ada@thegriffinfund.org',
  });
  assert.match(block, /Director of Public Relations, The Griffin Fund/);
  assert.equal(block.includes('Analyst, The Griffin Fund'), false);
});
