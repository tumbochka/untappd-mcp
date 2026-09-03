import { z } from 'zod';

const GRID_EPSILON = 1e-6;

function isMultipleOf(value: number, step: number): boolean {
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < GRID_EPSILON;
}

/**
 * Untappd check-in ratings run 1..5. The mobile app uses quarter steps; the API
 * accepts finer values. We allow the 0.1 grid plus the .25/.75 quarters, i.e.
 * fractional parts .0 .1 .2 .25 .3 .4 .5 .6 .7 .75 .8 .9 — and reject .05 .15 etc.
 */
export function isRatingOnGrid(value: number): boolean {
  if (!(value >= 1 && value <= 5)) {
    return false;
  }
  return isMultipleOf(value, 0.1) || isMultipleOf(value, 0.25);
}

/**
 * Snap a rating to the nearest allowed grid point and render it without float
 * artefacts (`0.1 * 3` -> `"0.30000000000000004"`). Values already on the grid
 * are returned unchanged apart from formatting.
 */
export function formatRating(value: number): string {
  const candidates = [Math.round(value * 10) / 10, Math.round(value * 4) / 4];
  const snapped = candidates.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  );
  return String(Number(snapped.toFixed(2)));
}

export const checkInRatingSchema = z
  .number()
  .min(1)
  .max(5)
  .refine(isRatingOnGrid, {
    message: 'Rating must be a multiple of 0.1, or a .25 / .75 value (for example 3.7, 3.75, or 4).',
  })
  .optional()
  .describe('Rating 1 to 5, in steps of 0.1 plus .25 and .75 values (for example 3.75).');
