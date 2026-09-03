import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInRatingSchema, formatRating, isRatingOnGrid } from '../src/untappd/rating.js';

test('isRatingOnGrid accepts the 0.1 grid plus quarter values', () => {
  for (const value of [1, 3, 3.5, 3.7, 3.75, 4.25, 4.9, 5]) {
    assert.equal(isRatingOnGrid(value), true, `expected ${value} on grid`);
  }
});

test('isRatingOnGrid rejects off-grid and out-of-range values', () => {
  for (const value of [0.9, 5.1, 3.05, 3.15, 3.35, 3.55, 3.65, 3.85, 3.95, 3.72]) {
    assert.equal(isRatingOnGrid(value), false, `expected ${value} off grid`);
  }
});

test('formatRating snaps to the nearest grid point and drops float noise', () => {
  assert.equal(formatRating(0.1 * 3 + 3.4), '3.7');
  assert.equal(formatRating(3.75), '3.75');
  assert.equal(formatRating(3.72), '3.7');
  assert.equal(formatRating(4.13), '4.1');
  assert.equal(formatRating(4), '4');
  assert.equal(formatRating(4.12), '4.1');
  assert.equal(formatRating(4.7), '4.7');
});

test('checkInRatingSchema parses grid values and rejects off-grid ones', () => {
  assert.equal(checkInRatingSchema.safeParse(3.75).success, true);
  assert.equal(checkInRatingSchema.safeParse(3.7).success, true);
  assert.equal(checkInRatingSchema.safeParse(undefined).success, true);
  assert.equal(checkInRatingSchema.safeParse(3.72).success, false);
  assert.equal(checkInRatingSchema.safeParse(0.5).success, false);
  assert.equal(checkInRatingSchema.safeParse(5.5).success, false);
});
