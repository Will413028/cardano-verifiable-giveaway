import { roundTime } from '@giveaway/protocol';

// Bounded retention (ADR 2026-10-18-wallet-auth-and-bounded-retention with Amendment 5, BR-08, BR-17, B5): a hosted
// bundle is kept until 12 months after its base time, the earlier of its draw's round time and the first time that
// commitment was hosted. Counting from the round alone let a draw whose round lies years ahead keep its bytes until a
// year after that round; counting from the first hosting (not from each upload) keeps a commitment hosted at most 12
// months past its first hosting, however often it is uploaded again, and a draw hosted after its round no longer than
// 12 months past the round. Every hosting is signed by the owner (plan step 11, apps/api/src/auth.ts), so the first
// hosting time is the owner's. The owner may extend it 12 months at a time, at most MAX_EXTENSIONS times: 36 months
// after the base time in all. Months are calendar months in UTC (Date.setUTCMonth: a day missing from the target month
// rolls into the next one, so 29 February plus 12 months is 1 March).
export const HOSTING_MONTHS = 12;
// Owner extensions of HOSTING_MONTHS each (PD4: at most 36 months after the base time in all).
export const MAX_EXTENSIONS = 2;
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
// The end of the hosting period of a draw first hosted at `uploadedAt` (the first hosting of that commitment, kept
// across expiry, deletion and takedown: apps/api/migrations/0003_first_hosting.sql) after `extensions` owner
// extensions (0 to MAX_EXTENSIONS, kept on the same row). Always counted from the base time, so the cap is exactly
// base + 36 months whatever the calendar does to each step.
export function hostingExpiry(round: number, uploadedAt: number, extensions = 0): number {
  if (!Number.isInteger(extensions) || extensions < 0 || extensions > MAX_EXTENSIONS)
    throw new Error(`Extensions must be 0 to ${MAX_EXTENSIONS}`);
  return addMonths(retentionBase(round, uploadedAt), HOSTING_MONTHS * (1 + extensions));
}
// 12 months after the round time. Null when no date represents it (a round up to Number.MAX_SAFE_INTEGER passes
// validateBundle; Date covers ±8.64e15 ms).
export function roundExpiry(round: number): number | null {
  const at = addMonths(roundTime(round), HOSTING_MONTHS);
  return Number.isSafeInteger(at) ? at : null;
}
// Until when the first hosting time of a commitment must be kept (first_hosting.keep_until): no expiry it can still
// produce, hostingExpiry(round, firstHosted), lies after it, and from then on an upload without the row is expired too
// (its base is the round time, which is then more than 12 months ago). Not simply roundExpiry: addMonths is not
// monotonic (2028-02-29T23:00Z + 12 months = 2029-03-01T23:00Z, after 2028-03-01T00:00Z + 12 months =
// 2029-03-01T00:00Z), so a first hosting just before a round at a month boundary can expire after roundExpiry.
// Null (kept for good) when the round has no date.
// An extension moves the expiry and so this time with it (apps/api/src/owner.ts `extend`).
export function firstHostingKeepUntil(round: number, firstHosted: number, extensions = 0): number | null {
  const byRound = roundExpiry(round);
  return byRound === null ? null : Math.max(byRound, hostingExpiry(round, firstHosted, extensions));
}
// What one Cron run removes at most (D1 deletes in one statement, R2 deletes up to 1,000 keys per call); the rest waits
// for the next run, and reads refuse an expired record meanwhile (`expires_at` is checked on read).
export const SWEEP_LIMIT = 500;
