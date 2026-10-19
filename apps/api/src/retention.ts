import { roundTime } from '@giveaway/protocol';

// Bounded retention (ADR 2026-10-18-wallet-auth-and-bounded-retention with Amendment 5, BR-08, BR-17, B5): a hosted
// bundle is kept until 12 months after its base time, the earlier of its draw's round time and its upload. Counting
// from the round alone let a draw whose round lies years ahead keep its bytes until a year after that round; counting
// from the earlier keeps every record at most 12 months past its upload, and a draw hosted after its round no longer
// than 12 months past the round. Owner extensions (12 months each, at most 36 months after the base time) arrive with
// the signed owner operations of plan step 11. Months are calendar months in UTC (Date.setUTCMonth: a day missing from
// the target month rolls into the next one, so 29 February plus 12 months is 1 March).
export const HOSTING_MONTHS = 12;
export function addMonths(unixSeconds: number, months: number): number {
  const date = new Date(unixSeconds * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000);
}
// The time retention is counted from (Unix seconds). It is never later than the upload, so every expiry is a
// representable date, whatever round validateBundle accepted.
export function retentionBase(round: number, uploadedAt: number): number {
  return Math.min(roundTime(round), uploadedAt);
}
// The end of the hosting period of a draw uploaded at `uploadedAt`.
export function hostingExpiry(round: number, uploadedAt: number): number {
  return addMonths(retentionBase(round, uploadedAt), HOSTING_MONTHS);
}
// What one Cron run removes at most (D1 deletes in one statement, R2 deletes up to 1,000 keys per call); the rest waits
// for the next run, and reads refuse an expired record meanwhile (`expires_at` is checked on read).
export const SWEEP_LIMIT = 500;
