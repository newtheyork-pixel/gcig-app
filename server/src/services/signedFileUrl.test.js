import test from 'node:test';
import assert from 'node:assert/strict';

// These tokens are the only credential guarding an internal research
// document once it's in an iframe URL, so the interesting cases are all
// the ways a bad one must be refused: forged signature, tampered claims,
// expired, malformed, signed under a different secret. A false accept
// here reads someone's pitch deck.

process.env.JWT_SECRET = 'test-secret-for-signed-file-urls';
const { signFileToken, verifyFileToken } = await import('./signedFileUrl.js');

test('round-trips the item id and the requesting user', () => {
  const token = signFileToken('ITEM!123', { userId: 42 });
  const claims = verifyFileToken(token);
  assert.equal(claims.itemId, 'ITEM!123');
  assert.equal(claims.userId, 42);
});

test('userId is optional and comes back null', () => {
  assert.equal(verifyFileToken(signFileToken('ABC')).userId, null);
});

test('rejects a tampered payload', () => {
  const token = signFileToken('ITEM-A');
  const forged = Buffer.from(JSON.stringify({
    i: 'ITEM-B',
    u: null,
    e: Date.now() + 60_000,
  }), 'utf8').toString('base64url');
  // Keep the real signature, swap the claims it covers.
  const attack = `${forged}.${token.slice(token.lastIndexOf('.') + 1)}`;
  assert.equal(verifyFileToken(attack), null);
});

test('rejects a tampered signature', () => {
  const token = signFileToken('ITEM-A');
  const dot = token.lastIndexOf('.');
  const flipped = token.slice(dot + 1).split('').reverse().join('');
  assert.equal(verifyFileToken(`${token.slice(0, dot)}.${flipped}`), null);
});

test('rejects a token signed under a different secret', () => {
  const token = signFileToken('ITEM-A');
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-completely-different-secret';
  try {
    assert.equal(verifyFileToken(token), null);
  } finally {
    process.env.JWT_SECRET = original;
  }
});

test('rejects an expired token', () => {
  // Negative TTL puts the expiry in the past at mint time.
  assert.equal(verifyFileToken(signFileToken('ITEM-A', { ttlMs: -1000 })), null);
});

test('accepts right up to the expiry boundary', () => {
  assert.ok(verifyFileToken(signFileToken('ITEM-A', { ttlMs: 5_000 })));
});

test('rejects malformed input without throwing', () => {
  for (const bad of [
    undefined, null, 0, {}, [],
    '', '.', 'nodot', 'a.', '.b',
    'not-base64!!.sig',
    'x'.repeat(5000),
  ]) {
    assert.equal(verifyFileToken(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a token for one item never validates as another', () => {
  // The route compares claims.itemId against the path segment; this
  // pins the property that makes that comparison meaningful.
  const a = verifyFileToken(signFileToken('ITEM-A'));
  assert.notEqual(a.itemId, 'ITEM-B');
});
