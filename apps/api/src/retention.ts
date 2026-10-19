import { roundTime } from '@giveaway/protocol';

// Bounded retention (ADR 2026-10-18-wallet-auth-and-bounded-retention, BR-08, B5): a hosted bundle is kept until 12
// months after its draw's round. Owner extensions (12 months each, at most 36 months after the round) arrive with the
// signed owner operations of plan step 11. Months are calendar months in UTC (Date.setUTCMonth: a day missing from the
// target month rolls into the next one, so 29 February plus 12 months is 1 March).
export const HOSTING_MONTHS = 12;
export function addMonths(unixSeconds: number, months: number): number {
  const date = new Date(unixSeconds * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000);
}
// The end of the hosting period of a draw, or null when the round lies so far ahead that no date represents it (a
// round up to Number.MAX_SAFE_INTEGER passes validateBundle; Date covers ±8.64e15 ms). The upload gate refuses such a
// draw instead of storing a NaN expiry.
export function hostingExpiry(round: number): number | null {
  const expiresAt = addMonths(roundTime(round), HOSTING_MONTHS);
  return Number.isSafeInteger(expiresAt) ? expiresAt : null;
}
// What one Cron run removes at most (D1 deletes in one statement, R2 deletes up to 1,000 keys per call); the rest waits
// for the next run, and reads refuse an expired record meanwhile (`expires_at` is checked on read).
export const SWEEP_LIMIT = 500;
