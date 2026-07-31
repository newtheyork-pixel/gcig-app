import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placeStorm } from './weatherSignals.js';

// "TS Genevieve, 22.1N 128.6W" tells a reader nothing they can act on.
// These pin the difference between a storm that matters and one that is
// weather happening to nobody.
describe('placeStorm', () => {
  it('calls a mid-Pacific storm open ocean and not threatening', () => {
    const p = placeStorm({ latitude: 22.1, longitude: -128.6 });
    assert.match(p.where, /open ocean/);
    assert.equal(p.threatening, false);
  });

  it('names the coast a Gulf storm is near, and calls it threatening', () => {
    const p = placeStorm({ latitude: 28.0, longitude: -92.0 });
    assert.equal(p.nearest, 'Louisiana coast');
    assert.equal(p.threatening, true);
  });

  it('says so rather than guessing when there is no position', () => {
    const p = placeStorm({});
    assert.equal(p.where, 'position unknown');
    assert.equal(p.threatening, false);
  });
});
