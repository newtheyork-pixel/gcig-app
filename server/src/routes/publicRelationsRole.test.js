import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The role is registered in several lists that do not import each
// other. A missing one is how an admin picks a role the server then
// rejects, or how the badge prints the enum value. Read the files.

function src(url) {
  return readFileSync(new URL(url, import.meta.url), 'utf8');
}

test('Director of Public Relations is on the assignable role list', () => {
  const users = src('./users.js');
  assert.match(users, /'DirectorOfPublicRelations'/);
  // FormerPresident is the role stripped from primary assignment. This
  // office must stay pickable.
  const assignable = users.slice(
    users.indexOf('const ASSIGNABLE_ROLES'),
    users.indexOf('function generateTempPassword')
  );
  assert.match(assignable, /filter\(\(r\) => r !== 'FormerPresident'\)/);
  assert.equal(assignable.includes('DirectorOfPublicRelations'), false);
});

test('the members page can offer the role', () => {
  const members = src('../../../client/src/pages/Members.jsx');
  assert.match(members, /'DirectorOfPublicRelations'/);
  const badge = src('../../../client/src/components/RoleBadge.jsx');
  assert.match(badge, /DirectorOfPublicRelations: 'Director of Public Relations'/);
});

test('the enum value is appended, not inserted', () => {
  const schema = src('../../prisma/schema.prisma');
  const block = schema.slice(schema.indexOf('enum Role'), schema.indexOf('enum AttendanceStatus'));
  assert.ok(
    block.lastIndexOf('DirectorOfPublicRelations') > block.lastIndexOf('FormerPresident'),
    'new enum values are appended so existing ordinals stay put'
  );
  const migration = src(
    '../../prisma/migrations/20261008000000_add_director_of_public_relations_role/migration.sql'
  );
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'DirectorOfPublicRelations'/);
});
