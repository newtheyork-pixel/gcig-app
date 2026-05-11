#!/usr/bin/env node
// Force-delete a TradeRequest row regardless of envelope state. Use when
// an envelope was sent with a broken PDF and the team wants to reclaim
// the underlying Buy sessions for a fresh attempt — the normal DELETE
// endpoint refuses anything that already has a docusignEnvelopeId.
//
// Void the envelope in DocuSign first if it shouldn't sit around in
// signers' inboxes; this script only touches the database.
//
// Usage:
//   node server/scripts/wipe-trade-request.js <id>

import prisma from '../src/db.js';

const id = Number(process.argv[2]);
if (!Number.isFinite(id)) {
  console.error('Usage: node server/scripts/wipe-trade-request.js <id>');
  process.exit(1);
}

const tr = await prisma.tradeRequest.findUnique({
  where: { id },
  include: { items: true },
});
if (!tr) {
  console.error(`TradeRequest ${id} not found.`);
  process.exit(1);
}

console.error(
  `Deleting TradeRequest ${id} (envelope ${tr.docusignEnvelopeId || 'none'}, ` +
    `status ${tr.docusignStatus || 'none'}, ${tr.items.length} item${
      tr.items.length === 1 ? '' : 's'
    })…`
);

await prisma.tradeRequest.delete({ where: { id } });

console.error(`Done. Buy sessions reclaimed by this request are now eligible again.`);
await prisma.$disconnect();
