import type { Ctx } from './context.ts';
import type { Cards, CardRow } from './cards.ts';
import { CARDS_FOR_ITEM_SQL, CARDS_FOR_TAG_SQL, retrievability } from './cards.ts';
import type { Review } from './review.ts';
import { localDate, startOfLocalDay } from '../util.ts';

export interface MasteryRow {
  id?: string;
  name: string;
  cards: number;
  reviewed: number;
  /** Mean probability of recall now across all cards (new cards count as 0). */
  mastery: number;
  /** Share of review-phase answers not rated Again, last 90 days (null if no reviews). */
  retention: number | null;
  lapses: number;
  due: number;
}

export interface Stats {
  totals: { sources: Record<string, number>; notes: Record<string, number>; cards: Record<string, number>; suspended: number };
  retention: { days: number; reviews: number; rate: number | null }[];
  daily: { date: string; reviews: number; again: number; minutes: number }[];
  forecast: { date: string; count: number }[];
  streak: number;
  reviewedToday: number;
  topics: MasteryRow[];
  sources: MasteryRow[];
}

export function createStats(ctx: Ctx, cards: Cards, review: Review) {
  const { db } = ctx;

  function mastery(rows: CardRow[], now: Date): Omit<MasteryRow, 'name' | 'id'> {
    const ids = rows.map((r) => r.id);
    const since = new Date(now.getTime() - 90 * 86400_000).toISOString();
    const rev = ids.length
      ? db.get<{ n: number; ok: number }>(
          `SELECT count(*) AS n, sum(rating > 1) AS ok FROM review_logs
           WHERE state = 2 AND reviewed_at >= ? AND card_id IN (SELECT value FROM json_each(?))`,
          [since, JSON.stringify(ids)],
        )!
      : { n: 0, ok: 0 };
    const rs = rows.map((r) => retrievability(r, now) ?? 0);
    return {
      cards: rows.length,
      reviewed: rows.filter((r) => r.state !== 0).length,
      mastery: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
      retention: rev.n ? rev.ok / rev.n : null,
      lapses: rows.reduce((a, r) => a + r.lapses, 0),
      due: rows.filter((r) => r.state !== 0 && new Date(r.due) <= now).length,
    };
  }

  function compute(now = new Date()): Stats {
    const count = (sql: string) =>
      Object.fromEntries(db.all<{ k: string; n: number }>(sql).map((r) => [r.k, r.n])) as Record<string, number>;
    const stateName = ['new', 'learning', 'review', 'relearning'];
    const cardStates = db
      .all<{ state: number; n: number }>('SELECT state, count(*) AS n FROM cards WHERE suspended = 0 GROUP BY state')
      .reduce<Record<string, number>>((o, r) => ({ ...o, [stateName[r.state]]: r.n }), {});

    const retention = [7, 30, 90].map((days) => {
      const r = db.get<{ n: number; ok: number }>(
        `SELECT count(*) AS n, sum(rating > 1) AS ok FROM review_logs WHERE state = 2 AND reviewed_at >= ?`,
        [new Date(now.getTime() - days * 86400_000).toISOString()],
      )!;
      return { days, reviews: r.n, rate: r.n ? r.ok / r.n : null };
    });

    // Daily activity for the last 30 days, bucketed by local date.
    const start = startOfLocalDay(now);
    start.setDate(start.getDate() - 29);
    const daily = new Map<string, { date: string; reviews: number; again: number; minutes: number }>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = localDate(d);
      daily.set(key, { date: key, reviews: 0, again: 0, minutes: 0 });
    }
    for (const r of db.all<{ reviewed_at: string; rating: number; duration_ms: number | null }>(
      'SELECT reviewed_at, rating, duration_ms FROM review_logs WHERE reviewed_at >= ?',
      [start.toISOString()],
    )) {
      const b = daily.get(localDate(new Date(r.reviewed_at)));
      if (!b) continue;
      b.reviews++;
      if (r.rating === 1) b.again++;
      b.minutes += Math.min(r.duration_ms ?? 0, 5 * 60_000) / 60_000;
    }
    const days = [...daily.values()].map((d) => ({ ...d, minutes: Math.round(d.minutes * 10) / 10 }));

    // Streak: consecutive local days with at least one review, ending today (or yesterday if none yet today).
    const reviewDays = new Set(
      db.all<{ reviewed_at: string }>('SELECT reviewed_at FROM review_logs ORDER BY reviewed_at DESC LIMIT 20000').map((r) => localDate(new Date(r.reviewed_at))),
    );
    let streak = 0;
    const cursor = new Date(now);
    if (!reviewDays.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (reviewDays.has(localDate(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    const tagNames = db.all<{ name: string }>(
      `SELECT DISTINCT t.name FROM tags t JOIN item_tags it ON it.tag_id = t.id`,
    );
    const topics = tagNames
      .map(({ name }) => {
        const rows = db.all<CardRow>(`SELECT * FROM cards WHERE suspended = 0 AND id IN (${CARDS_FOR_TAG_SQL})`, { topic: name });
        return { name, ...mastery(rows, now) };
      })
      .filter((t) => t.cards > 0)
      .sort((a, b) => a.mastery - b.mastery);

    const sources = db
      .all<{ id: string; title: string }>('SELECT id, title FROM sources')
      .map((s) => {
        const rows = db.all<CardRow>(`SELECT * FROM cards WHERE suspended = 0 AND id IN (${CARDS_FOR_ITEM_SQL})`, { type: 'source', id: s.id });
        return { id: s.id, name: s.title, ...mastery(rows, now) };
      })
      .filter((s) => s.cards > 0)
      .sort((a, b) => a.mastery - b.mastery);

    return {
      totals: {
        sources: count('SELECT status AS k, count(*) AS n FROM sources GROUP BY status'),
        notes: count('SELECT kind AS k, count(*) AS n FROM notes GROUP BY kind'),
        cards: cardStates,
        suspended: db.get<{ n: number }>('SELECT count(*) AS n FROM cards WHERE suspended = 1')!.n,
      },
      retention,
      daily: days,
      forecast: review.forecast(30, now),
      streak,
      reviewedToday: daily.get(localDate(now))?.reviews ?? 0,
      topics,
      sources,
    };
  }

  return { compute };
}
export type StatsService = ReturnType<typeof createStats>;
