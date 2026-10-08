import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeApprovalState } from './tradeRequests.js';

// The list's buttons are this function. A signed envelope that was
// replaced must not still offer "Mark filled", and a sent envelope the
// broker already traded must still be fillable.

test('a signed unfilled approval can be filled or closed', () => {
  const s = tradeApprovalState({ docusignStatus: 'completed', executedAt: null, resolution: null });
  assert.equal(s.phase, 'signed');
  assert.equal(s.canFill, true);
  assert.equal(s.canClose, true);
  assert.equal(s.fillWhileUnsigned, false);
});

test('a sent envelope can be marked filled before DocuSign completes', () => {
  const s = tradeApprovalState({ docusignStatus: 'sent' });
  assert.equal(s.phase, 'sent');
  assert.equal(s.canFill, true);
  assert.equal(s.fillWhileUnsigned, true);
  assert.equal(s.canClose, true);
});

test('superseded wins over a signed DocuSign status and stops Mark filled', () => {
  const s = tradeApprovalState({
    docusignStatus: 'completed',
    resolution: 'superseded',
    executedAt: null,
  });
  assert.equal(s.phase, 'superseded');
  assert.equal(s.canFill, false);
  assert.equal(s.canClose, false);
});

test('cancelled closes the row the same way', () => {
  const s = tradeApprovalState({ docusignStatus: 'sent', resolution: 'cancelled' });
  assert.equal(s.phase, 'cancelled');
  assert.equal(s.canFill, false);
  assert.equal(s.canClose, false);
});

test('filled wins over a DocuSign status that is still sent', () => {
  const s = tradeApprovalState({
    docusignStatus: 'sent',
    executedAt: '2026-08-24T00:00:00.000Z',
    settlementMode: 'record-only',
  });
  assert.equal(s.phase, 'filled');
  assert.equal(s.canFill, false);
  assert.equal(s.canClose, false);
});

test('declined and voided are terminal and are not fills', () => {
  for (const status of ['declined', 'voided']) {
    const s = tradeApprovalState({ docusignStatus: status });
    assert.equal(s.phase, status);
    assert.equal(s.canFill, false);
    assert.equal(s.canClose, false);
  }
});
