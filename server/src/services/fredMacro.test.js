import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericPrints } from './fredMacro.js';

test('an unpublished "." is skipped and the prior close remains', () => {
  const prints = numericPrints([
    { date: '2026-10-02', value: '.' },
    { date: '2026-10-01', value: '4.12' },
    { date: '2026-09-30', value: '4.15' },
  ]);
  assert.deepEqual(prints, [
    { date: '2026-10-01', value: 4.12 },
    { date: '2026-09-30', value: 4.15 },
  ]);
});

test('a series of placeholders is no print at all', () => {
  assert.deepEqual(numericPrints([{ value: '.' }, { value: '' }]), []);
});
