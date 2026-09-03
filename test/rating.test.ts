import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInRatingSchema, formatRating, isRatingOnGrid } from '../src/untappd/rating.js';

test('isRatingOnGrid accepts 1..5 quarter steps', () => {
  for (const value of [1, 1.25, 3, 3.5, 3.75, 4.25, 4.75, 5]) {
    assert.equal(isRatingOnGrid(value), true, `expected ${value} on grid`);
  }
});

test('isRatingOnGrid rejects off-grid and out-of-range values', () => {
  for (const value of [0.75, 5.25, 3.1, 3.3, 3.7, 3.6, 3.05]) {
    assert.equal(isRatingOnGrid(value), false, `expected ${value} off grid`);
  }
});

test('formatRating snaps to the nearest quarter and drops float noise', () => {
  assert.equal(formatRating(0.25 * 3 + 3), '3.75');
  assert.equal(formatRating(3.75), '3.75');
  assert.equal(formatRating(3.7), '3.75');
  assert.equal(formatRating(3.6), '3.5');
  assert.equal(formatRating(4), '4');
  assert.equal(formatRating(4.1), '4');
  assert.equal(formatRating(4.2), '4.25');
});

test('checkInRatingSchema parses quarter-step values and rejects the rest', () => {
  assert.equal(checkInRatingSchema.safeParse(3.75).success, true);
  assert.equal(checkInRatingSchema.safeParse(3.5).success, true);
  assert.equal(checkInRatingSchema.safeParse(undefined).success, true);
  assert.equal(checkInRatingSchema.safeParse(3.7).success, false);
  assert.equal(checkInRatingSchema.safeParse(3.1).success, false);
  assert.equal(checkInRatingSchema.safeParse(0.5).success, false);
  assert.equal(checkInRatingSchema.safeParse(5.25).success, false);
});
