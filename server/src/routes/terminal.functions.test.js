import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The client owns the real function registry; the server keeps its own
// copy in KNOWN_FUNCTIONS to drive natural-language command parsing.
// Two lists of the same thing drift, and this one had: GF and FIL
// existed in the terminal and worked when typed as mnemonics — the
// client parses those locally — but plain-English commands are routed
// server-side against KNOWN_FUNCTIONS, so no question phrased in English
// could ever open Graph Fundamentals or Filings. Nothing errored; those
// two panels were simply unreachable that way.
//
// Reading the client file from a server test is unusual, but the
// alternative is trusting two hand-maintained lists to stay equal.

const registryPath = path.join(
  import.meta.dirname, '..', '..', '..', 'client', 'src', 'terminal', 'registry.js'
);

test('every client terminal function is known to the server parser', async () => {
  if (!fs.existsSync(registryPath)) {
    // Server deployed without the client tree — nothing to compare.
    return;
  }
  const src = fs.readFileSync(registryPath, 'utf8');
  const clientIds = [...src.matchAll(/\bid:\s*'([A-Z0-9]+)'/g)].map((m) => m[1]);
  assert.ok(clientIds.length > 20, 'sanity: the registry should list many functions');

  const routeSrc = fs.readFileSync(
    path.join(import.meta.dirname, 'terminal.js'), 'utf8'
  );
  const block = routeSrc.slice(
    routeSrc.indexOf('const KNOWN_FUNCTIONS'),
    routeSrc.indexOf('router.get(\'/functions\'')
  );
  const serverIds = [...block.matchAll(/\{\s*id:\s*'([A-Z0-9]+)'/g)].map((m) => m[1]);

  const missing = clientIds.filter((id) => !serverIds.includes(id));
  assert.deepEqual(
    missing, [],
    `these functions exist in the terminal but plain-English commands cannot reach them: ${missing.join(', ')}`
  );
});
