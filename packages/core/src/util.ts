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
