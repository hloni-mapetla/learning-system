import { ulid } from 'ulid';
import { createHash } from 'node:crypto';

export const newId = (): string => ulid();
export const nowIso = (): string => new Date().toISOString();
export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** Local calendar date (YYYY-MM-DD) for a Date, in the process's timezone. */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** End of the local day containing d, as a Date. */
export function endOfLocalDay(d: Date = new Date()): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

export function startOfLocalDay(d: Date = new Date()): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

/** Momentum features (done list, evening planning) roll the day over at this hour, so 00:30 still counts as "tonight". */
export const DAY_ROLLOVER_HOUR = 4;

/** The momentum day containing `now`: its date and [start, end) bounds, rolling over at DAY_ROLLOVER_HOUR. */
export function momentumDay(now: Date = new Date()): { date: string; start: Date; end: Date } {
  const start = new Date(now);
  if (start.getHours() < DAY_ROLLOVER_HOUR) start.setDate(start.getDate() - 1);
  start.setHours(DAY_ROLLOVER_HOUR, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { date: localDate(start), start, end };
}

export function parseJsonArray(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1).trimEnd() + '…';
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`);
  }
}

export class ValidationError extends Error {
  readonly status = 400;
}

/** Add days to a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

/** "HH:MM" on a momentum date as a Date; times before the rollover hour belong to the next calendar morning. */
export function atLocalTime(date: string, hhmm: string): Date {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) throw new ValidationError(`Expected a time like 07:30, got "${hhmm}"`);
  const d = new Date(`${date}T00:00:00`);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (Number(m[1]) < DAY_ROLLOVER_HOUR) d.setDate(d.getDate() + 1);
  return d;
}

/** "today", "tomorrow", "yesterday" or YYYY-MM-DD, as a momentum date. */
export function resolveDay(spec: string | undefined, now: Date = new Date()): string {
  const today = momentumDay(now).date;
  if (!spec || spec === 'today') return today;
  if (spec === 'tomorrow') return addDays(today, 1);
  if (spec === 'yesterday') return addDays(today, -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec)) throw new ValidationError(`Expected today, tomorrow or YYYY-MM-DD, got "${spec}"`);
  return spec;
}
