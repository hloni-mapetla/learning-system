import { fsrs, Rating, type FSRS, type Grade } from 'ts-fsrs';
import type { Ctx } from './context.ts';
import type { CardView, RatingName } from '../types.ts';
import { RATINGS } from '../types.ts';
import type { RatingInput } from '../schemas.ts';
import { CARDS_FOR_TAG_SQL, rowToFsrs, type CardRow, type Cards } from './cards.ts';
import type { SettingsService } from './settings.ts';
import { endOfLocalDay, localDate, newId, nowIso, NotFoundError, startOfLocalDay, ValidationError } from '../util.ts';

export function toGrade(r: RatingInput): Grade {
  const n = typeof r === 'number' ? r : RATINGS.indexOf(r) + 1;
  if (n < 1 || n > 4) throw new ValidationError(`Invalid rating: ${r}`);
  return n as Grade;
}

export interface DueOpts {
  limit?: number;
  /** Restrict to these card ids (e.g. a topic). */
  cardIds?: string[];
  /** Tag/topic filter (tag or tag prefix). */
  tag?: string;
  includeNew?: boolean;
  now?: Date;
}

export interface ReviewResult {
  card: CardView;
  rating: RatingName;
  /** Human-readable time until the next review. */
  nextIn: string;
  previousState: string;
  logId: string;
}

export function humanInterval(from: Date, to: Date): string {
  const mins = Math.round((to.getTime() - from.getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d`;
  const months = days / 30.4;
  if (months < 12) return `${months.toFixed(months < 3 ? 1 : 0)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

export function createReview(ctx: Ctx, cards: Cards, settings: SettingsService) {
  const { db } = ctx;

  function scheduler(): FSRS {
    const s = settings.get();
    return fsrs({
      request_retention: s.desiredRetention,
      maximum_interval: s.maximumInterval,
      enable_fuzz: true,
      enable_short_term: true,
      learning_steps: s.learningSteps as any,
      relearning_steps: s.relearningSteps as any,
      ...(s.fsrsWeights ? { w: s.fsrsWeights } : {}),
    });
  }

  function newIntroducedToday(now: Date): number {
    return db.get<{ n: number }>(
      'SELECT count(DISTINCT card_id) AS n FROM review_logs WHERE state = 0 AND reviewed_at >= ?',
      [startOfLocalDay(now).toISOString()],
    )!.n;
  }

  function filterSql(opts: DueOpts, p: Record<string, unknown>): string {
    const parts = ['c.suspended = 0'];
    if (opts.cardIds) {
      parts.push('c.id IN (SELECT value FROM json_each(:ids))');
      p.ids = JSON.stringify(opts.cardIds);
    }
    if (opts.tag) {
      parts.push(`c.id IN (${CARDS_FOR_TAG_SQL})`);
      p.topic = opts.tag;
    }
    return parts.join(' AND ');
  }

  /**
   * Cards to review now, in order: learning/relearning steps, then overdue reviews (most overdue first),
   * then new cards within today's new-card quota.
   */
  function due(opts: DueOpts = {}): CardView[] {
    const now = opts.now ?? new Date();
    const s = settings.get();
    const limit = opts.limit ?? 50;
    const p: Record<string, unknown> = {
      now: now.toISOString(),
      ahead: new Date(now.getTime() + s.learnAheadMinutes * 60000).toISOString(),
    };
    const f = filterSql(opts, p);
    const learning = db.all<CardRow>(`SELECT c.* FROM cards c WHERE ${f} AND c.state IN (1, 3) AND c.due <= :ahead ORDER BY c.due`, p);
    const reviews = db.all<CardRow>(`SELECT c.* FROM cards c WHERE ${f} AND c.state = 2 AND c.due <= :now ORDER BY c.due`, p);
    let rows = [...learning, ...reviews];
    if (opts.includeNew !== false && rows.length < limit) {
      const quota = Math.max(0, s.newCardsPerDay - newIntroducedToday(now));
      if (quota > 0) {
        rows = rows.concat(
          db.all<CardRow>(`SELECT c.* FROM cards c WHERE ${f} AND c.state = 0 ORDER BY c.created_at, c.rowid LIMIT :q`, {
            ...p,
            q: Math.min(quota, limit - rows.length),
          }),
        );
      }
    }
    return cards.hydrate(rows.slice(0, limit), now);
  }

  /** Counts for the daily task / dashboard: what's due by the end of today. */
  function counts(opts: Omit<DueOpts, 'limit'> = {}): { learning: number; review: number; new: number; total: number } {
    const now = opts.now ?? new Date();
    const s = settings.get();
    const p: Record<string, unknown> = { eod: endOfLocalDay(now).toISOString() };
    const f = filterSql(opts, p);
    const c = (sql: string) => db.get<{ n: number }>(sql, p)!.n;
    const learning = c(`SELECT count(*) AS n FROM cards c WHERE ${f} AND c.state IN (1, 3) AND c.due <= :eod`);
    const review = c(`SELECT count(*) AS n FROM cards c WHERE ${f} AND c.state = 2 AND c.due <= :eod`);
    const quota = Math.max(0, s.newCardsPerDay - newIntroducedToday(now));
    const fresh = Math.min(quota, c(`SELECT count(*) AS n FROM cards c WHERE ${f} AND c.state = 0`));
    return { learning, review, new: fresh, total: learning + review + fresh };
  }

  /** What each rating would do, for button labels. */
  function preview(cardId: string, now = new Date()): Record<RatingName, string> {
    const r = cards.row(cardId);
    const out = scheduler().repeat(rowToFsrs(r), now);
    return {
      again: humanInterval(now, out[Rating.Again].card.due),
      hard: humanInterval(now, out[Rating.Hard].card.due),
      good: humanInterval(now, out[Rating.Good].card.due),
      easy: humanInterval(now, out[Rating.Easy].card.due),
    };
  }

  function record(
    cardId: string,
    rating: RatingInput,
    opts: { grader?: 'self' | 'claude'; notes?: string | null; durationMs?: number | null; now?: Date } = {},
  ): ReviewResult {
    const now = opts.now ?? new Date();
    const grade = toGrade(rating);
    const prev = cards.row(cardId);
    const { card: next, log } = scheduler().next(rowToFsrs(prev), now, grade);
    const logId = newId();
    db.tx(() => {
      db.run(
        `UPDATE cards SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?,
           reps = ?, lapses = ?, state = ?, last_review = ?, updated_at = ? WHERE id = ?`,
        [next.due.toISOString(), next.stability, next.difficulty, next.elapsed_days, next.scheduled_days, next.learning_steps,
          next.reps, next.lapses, next.state, next.last_review?.toISOString() ?? now.toISOString(), nowIso(), cardId],
      );
      db.run(
        `INSERT INTO review_logs (id, card_id, rating, state, due, stability, difficulty, elapsed_days, last_elapsed_days,
           scheduled_days, learning_steps, reviewed_at, duration_ms, grader, notes, prev_card)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [logId, cardId, grade, log.state, log.due.toISOString(), log.stability, log.difficulty, log.elapsed_days,
          log.last_elapsed_days, log.scheduled_days, log.learning_steps, now.toISOString(), opts.durationMs ?? null,
          opts.grader ?? 'self', opts.notes ?? null, JSON.stringify(prev)],
      );
    });
    return {
      card: cards.get(cardId),
      rating: RATINGS[grade - 1],
      nextIn: humanInterval(now, next.due),
      previousState: ['new', 'learning', 'review', 'relearning'][prev.state],
      logId,
    };
  }

  /** Undo the most recent review (optionally of a specific card): restores the card's previous scheduling. */
  function undo(cardId?: string): CardView {
    const log = db.get<{ id: string; card_id: string; prev_card: string }>(
      `SELECT id, card_id, prev_card FROM review_logs ${cardId ? 'WHERE card_id = ?' : ''} ORDER BY rowid DESC LIMIT 1`,
      cardId ? [cardId] : [],
    );
    if (!log) throw new NotFoundError('review to undo', cardId ?? 'any');
    const prev = JSON.parse(log.prev_card) as CardRow;
    db.tx(() => {
      db.run(
        `UPDATE cards SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?,
           reps = ?, lapses = ?, state = ?, last_review = ?, updated_at = ? WHERE id = ?`,
        [prev.due, prev.stability, prev.difficulty, prev.elapsed_days, prev.scheduled_days, prev.learning_steps, prev.reps,
          prev.lapses, prev.state, prev.last_review, nowIso(), log.card_id],
      );
      db.run('DELETE FROM review_logs WHERE id = ?', [log.id]);
    });
    return cards.get(log.card_id);
  }

  /** Reset a card to new (e.g. after rewriting it substantially). */
  function forget(cardId: string): CardView {
    const now = nowIso();
    const r = db.run(
      `UPDATE cards SET due = ?, stability = 0, difficulty = 0, elapsed_days = 0, scheduled_days = 0, learning_steps = 0,
         reps = 0, lapses = 0, state = 0, last_review = NULL, updated_at = ? WHERE id = ?`,
      [now, now, cardId],
    );
    if (!r.changes) throw new NotFoundError('card', cardId);
    return cards.get(cardId);
  }

  /** Reviews due per local day for the next `days` days (overdue folded into today). */
  function forecast(days = 30, now = new Date()): { date: string; count: number }[] {
    const out = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      out.set(localDate(d), 0);
    }
    const end = new Date(now);
    end.setDate(end.getDate() + days);
    const rows = db.all<{ due: string }>(`SELECT due FROM cards WHERE suspended = 0 AND state <> 0 AND due < ?`, [
      endOfLocalDay(end).toISOString(),
    ]);
    const today = localDate(now);
    for (const r of rows) {
      const d = localDate(new Date(r.due));
      const key = d < today ? today : d;
      if (out.has(key)) out.set(key, out.get(key)! + 1);
    }
    return [...out].map(([date, count]) => ({ date, count }));
  }

  function history(cardId: string) {
    return db.all(
      `SELECT id, rating, state, reviewed_at AS reviewedAt, duration_ms AS durationMs, grader, notes, scheduled_days AS scheduledDays
       FROM review_logs WHERE card_id = ? ORDER BY reviewed_at DESC`,
      [cardId],
    );
  }

  return { due, counts, preview, record, undo, forget, forecast, history, scheduler };
}
export type Review = ReturnType<typeof createReview>;
