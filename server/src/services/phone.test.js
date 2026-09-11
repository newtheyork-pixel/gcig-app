import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePhone, formatPhone, telUrl } from './phone.js';

// The failure this guards against is not a number that fails to dial.
// It is a number that dials successfully to the wrong place, because
// something was silently discarded on the way in.

test('the shapes a store locator actually gives you', () => {
  for (const raw of [
    '(614) 555-0134',
    '614-555-0134',
    '614.555.0134',
    '6145550134',
    '1 (614) 555-0134',
    '+1 614 555 0134',
    ' 614 555 0134 ',
  ]) {
    assert.equal(parsePhone(raw)?.e164, '+16145550134', raw);
  }
});

test('an extension is carried, never dropped', () => {
  // Dropping it yields a VALID number for the wrong end of the business,
  // and the call then connects, which is why this is the sharp edge.
  for (const raw of [
    '614-555-0134 x231',
    '614-555-0134 ext 231',
    '(614) 555-0134 ext. 231',
    '614-555-0134 extension 231',
    '+16145550134;ext=231',
    '6145550134,231',
  ]) {
    const p = parsePhone(raw);
    assert.equal(p?.e164, '+16145550134', raw);
    assert.equal(p?.ext, '231', raw);
  }
});

test('the extension survives into the dial link', () => {
  assert.equal(telUrl(parsePhone('614-555-0134 x231')), 'tel:+16145550134;ext=231');
  assert.equal(telUrl(parsePhone('614-555-0134')), 'tel:+16145550134');
});

test('NANP typos are refused rather than dialled', () => {
  // A digit dropped or doubled while copying a store locator produces a
  // plausible-looking number for a door that is not in the sample.
  assert.equal(parsePhone('014-555-0134'), null, 'area code cannot start 0');
  assert.equal(parsePhone('114-555-0134'), null, 'area code cannot start 1');
  assert.equal(parsePhone('911-555-0134'), null, 'N11 is not an area code');
  assert.equal(parsePhone('411-555-0134'), null, 'N11 is not an area code');
  assert.equal(parsePhone('614-055-0134'), null, 'exchange cannot start 0');
  assert.equal(parsePhone('614-155-0134'), null, 'exchange cannot start 1');
  assert.equal(parsePhone('614-555-013'), null, 'nine digits');
  assert.equal(parsePhone('614-555-01345'), null, 'eleven digits');
});

test('nothing, and things that are not numbers', () => {
  assert.equal(parsePhone(null), null);
  assert.equal(parsePhone(undefined), null);
  assert.equal(parsePhone(''), null);
  assert.equal(parsePhone('   '), null);
  assert.equal(parsePhone('call the mall office'), null);
  assert.equal(parsePhone('x'.repeat(200)), null, 'a pasted paragraph is not a number');
  assert.equal(telUrl(null), null);
  assert.equal(formatPhone(null), '');
});

test('numbers outside the plan are carried but not vouched for', () => {
  // We cannot validate a UK number, so the only claim made is E.164
  // length. Better than refusing to dial a supplier in Birmingham.
  assert.equal(parsePhone('+44 20 7946 0958')?.e164, '+442079460958');
  assert.equal(formatPhone(parsePhone('+44 20 7946 0958')), '+442079460958');
  assert.equal(parsePhone('+1234'), null, 'too short to be anything');
  assert.equal(parsePhone('+1234567890123456'), null, 'longer than E.164 allows');
});

test('display form is the one people read back over a phone', () => {
  assert.equal(formatPhone(parsePhone('6145550134')), '(614) 555-0134');
  assert.equal(formatPhone(parsePhone('6145550134 x7')), '(614) 555-0134 ext. 7');
});
