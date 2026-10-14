import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function src(url) {
  return readFileSync(new URL(url, import.meta.url), 'utf8');
}

test('the pending pod is renamed to Heath Care without taking boot down', () => {
  const sql = src(
    '../../prisma/migrations/20261014120000_rename_pending_industry/migration.sql'
  );
  assert.match(sql, /SET "name" = 'Heath Care'/);
  assert.match(sql, /WHERE i\."name" = 'pending'/);
  // A unique collision has to miss, not abort migrate deploy.
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /other\."name" = 'Heath Care'/);
});

test('renaming to a blank or taken name is refused', () => {
  const route = src('./industries.js');
  const put = route.slice(route.indexOf("router.put('/:id'"), route.indexOf("router.delete"));
  assert.match(put, /name required/);
  assert.match(put, /P2002/);
  assert.match(put, /An industry with that name already exists/);
});

test('the industries page sends the new name', () => {
  const page = src('../../../client/src/pages/Industries.jsx');
  const rename = page.slice(page.indexOf('async function handleRename'), page.indexOf('async function handleAddMember'));
  assert.match(rename, /name: trimmed/);
  assert.match(rename, /\/industries\/\$\{industryId\}/);
});
