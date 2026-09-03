import { z } from 'zod';

const GRID_EPSILON = 1e-6;
const RATING_STEP = 0.25;

function isMultipleOf(value: number, step: number): boolean {
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < GRID_EPSILON;
}

/**
 * Untappd check-in ratings run 1..5 in quarter steps (1, 1.25, 1.5, ... 5) —
 * the same grid the mobile app uses and the finest the API stores.
 */
export function isRatingOnGrid(value: number): boolean {
  if (!(value >= 1 && value <= 5)) {
    return false;
  }
  return isMultipleOf(value, RATING_STEP);
}

/**
 * Snap a rating to the nearest quarter step and render it without float
 * artefacts (`0.25 * 3` -> `"0.7500000000000001"`). Values already on the grid
 * are returned unchanged apart from formatting.
 */
export function formatRating(value: number): string {
  const snapped = Math.round(value / RATING_STEP) * RATING_STEP;
  return String(Number(snapped.toFixed(2)));
}

export const checkInRatingSchema = z
  .number()
  .min(1)
  .max(5)
  .refine(isRatingOnGrid, {
    message: 'Rating must be 1 to 5 in steps of 0.25 (for example 3.25, 3.5, 3.75, or 4).',
  })
  .optional()
  .describe('Rating 1 to 5, in steps of 0.25 (for example 3.75).');
