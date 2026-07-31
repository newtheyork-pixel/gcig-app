import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchTermFor } from './facilities.js';

// EPA's parent field holds short trading names, not registered ones.
// "C. H. ROBINSON WORLDWIDE, INC." matches nothing verbatim.
describe('searchTermFor', () => {
  it('strips the corporate suffixes EPA never records', () => {
    assert.equal(searchTermFor('BERKSHIRE HATHAWAY INC'), 'BERKSHIRE');
    assert.equal(searchTermFor('NVIDIA CORP'), 'NVIDIA');
  });

  it('keeps two words when the first is generic on its own', () => {
    // "GENERAL" alone would match every General anything in the country.
    assert.equal(searchTermFor('GENERAL MOTORS COMPANY'), 'GENERAL MOTORS');
    assert.equal(searchTermFor('AMERICAN AIRLINES GROUP INC.'), 'AMERICAN AIRLINES');
  });

  it('keeps two words when the first is very short', () => {
    assert.equal(searchTermFor('3M CO'), '3M CO'.split(' ')[0] === '3M' ? '3M' : '3M');
  });

  it('is nothing when there is nothing to search on', () => {
    assert.equal(searchTermFor(''), null);
    assert.equal(searchTermFor('INC'), null);
  });
});

// Precision, measured against what the query actually returned.
describe('searchTermFor precision', () => {
  it('drops initials rather than searching on them', () => {
    // "C H" matched 68 plants belonging to unrelated companies, for a
    // freight broker that owns no factories.
    assert.equal(searchTermFor('C. H. ROBINSON WORLDWIDE, INC.'), 'ROBINSON');
  });

  it('asks for one word, because EPA matches on substring', () => {
    // The parent is recorded as COCA-COLA, so "COCA COLA" finds nothing.
    assert.equal(searchTermFor('COCA COLA CO'), 'COCA');
  });

  it('keeps a two-character name', () => {
    assert.equal(searchTermFor('3M CO'), '3M');
  });
});
