import type { Ctx } from './context.ts';
import type { Chain, ChainDay, DailyMinimum, DayLogEntry, DayMeasure, MomentumStats } from '../types.ts';
import type { Tasks } from './tasks.ts';
import type { Days } from './days.ts';
import type { SettingsService } from './settings.ts';
import type { Notes } from './notes.ts';
import { addDays, DAY_ROLLOVER_HOUR, momentumDay, nowIso, ValidationError } from '../util.ts';

export const REFLECTION_HEADING = 'Reflection';

// The momentum date of a stored UTC timestamp, in SQL (local time, rolling over at 4am).
const DAY_OF = (col: string) => `date(${col}, 'localtime', '-${DAY_ROLLOVER_HOUR} hours')`;

const EMPTY: DayMeasure = { sessions: 0, focusMinutes: 0, steps: 0 };

export function meets(m: DayMeasure, rule: DailyMinimum): boolean {
  const v = rule.kind === 'sessions' ? m.sessions : rule.kind === 'focus_minutes' ? m.focusMinutes : m.steps;
  return v >= rule.value;
}

/** The daily minimum and its chain, the end-of-day rating, and descriptive stats on starting and focus. */
export function createMomentum(ctx: Ctx, settings: SettingsService, notes: Notes, tasks: Tasks, days: Days) {
  const { db } = ctx;

  /** What each day in [from, to] counted: sessions started (not discarded), minutes in them, and steps. */
  function measures(from: string, to: string): Map<string, DayMeasure> {
    const out = new Map<string, DayMeasure>();
    const at = (d: string) => out.get(d) ?? (out.set(d, { ...EMPTY }), out.get(d)!);
    const p = { from, to };
    for (const r of db.all<{ d: string; n: number; minutes: number }>(
      `SELECT ${DAY_OF('started_at')} AS d, count(*) AS n,
         coalesce(sum(CASE WHEN ended_at IS NOT NULL THEN (julianday(ended_at) - julianday(started_at)) * 1440 END), 0) AS minutes
       FROM sessions WHERE outcome IS NULL OR outcome <> 'abandoned' GROUP BY d HAVING d BETWEEN :from AND :to`,
      p,
    )) {
      Object.assign(at(r.d), { sessions: r.n, focusMinutes: Math.round(r.minutes) });
    }
    for (const r of db.all<{ d: string; n: number }>(
      `SELECT d, count(*) AS n FROM (
         SELECT ${DAY_OF('completed_at')} AS d FROM subtasks WHERE completed_at IS NOT NULL
         UNION ALL SELECT ${DAY_OF('completed_at')} FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL
         UNION ALL SELECT d FROM (SELECT DISTINCT ${DAY_OF('at')} AS d, task_id FROM task_events WHERE type = 'steps_defined')
       ) GROUP BY d HAVING d BETWEEN :from AND :to`,
      p,
    )) {
      at(r.d).steps = r.n;
    }
    return out;
  }

  function measure(date: string): DayMeasure {
    return measures(date, date).get(date) ?? { ...EMPTY };
  }

  /** The calendar chain: which of the last `days` days met the minimum, and the current run. */
  function chain(opts: { days?: number; now?: Date } = {}): Chain {
    const now = opts.now ?? new Date();
    const today = momentumDay(now).date;
    const n = Math.max(1, Math.min(400, opts.days ?? 56));
    const from = addDays(today, -(n - 1));
    const rule = settings.get().dailyMinimum;
    const ms = measures(from, today);
    const rows = new Map(
      db.all<{ date: string; minimum_met: number | null; rating: number | null }>('SELECT date, minimum_met, rating FROM days WHERE date BETWEEN ? AND ?', [from, today]).map((r) => [r.date, r]),
    );
    const days: ChainDay[] = [];
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const m = ms.get(d) ?? { ...EMPTY };
      const frozen = rows.get(d)?.minimum_met;
      days.push({ date: d, met: frozen != null ? !!frozen : meets(m, rule), frozen: frozen != null, measure: m, rating: rows.get(d)?.rating ?? null });
    }
    const todayMet = days.at(-1)!.met;
    let current = 0;
    for (let i = days.length - (todayMet ? 1 : 2); i >= 0 && days[i].met; i--) current++;
    return { minimum: rule, days, current, todayMet };
  }

  /**
   * Change the daily minimum. Past days keep the verdict they had under the old rule (it's frozen onto them first),
   * so lowering or raising the bar never rewrites the chain.
   */
  function setMinimum(rule: DailyMinimum, now = new Date()): Chain {
    if (!(rule.value >= 1 && rule.value <= 600)) throw new ValidationError('The minimum must be between 1 and 600.');
    const old = settings.get().dailyMinimum;
    const today = momentumDay(now).date;
    db.tx(() => {
      // Days with no activity fail every rule, so only days with something in them need freezing.
      const ms = measures('0000-00-00', addDays(today, -1));
      const t = nowIso();
      for (const [date, m] of ms) {
        db.run(
          `INSERT INTO days (date, minimum_met, minimum_rule, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (date) DO UPDATE SET minimum_met = coalesce(days.minimum_met, excluded.minimum_met),
             minimum_rule = coalesce(days.minimum_rule, excluded.minimum_rule)`,
          [date, meets(m, old) ? 1 : 0, JSON.stringify(old), t, t],
        );
      }
      settings.set({ dailyMinimum: { kind: rule.kind, value: rule.value } });
    });
    return chain({ now });
  }

  /** End-of-day rating (1–5) and one line, kept on the day and written under "Reflection" in that day's daily note. */
  function rate(date: string, rating: number, note = '', now = new Date()) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ValidationError('Rate the day from 1 to 5.');
    const line = note.trim();
    const t = nowIso();
    db.tx(() => {
      db.run(
        `INSERT INTO days (date, rating, reflection, rated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET rating = excluded.rating, reflection = excluded.reflection, rated_at = excluded.rated_at, updated_at = excluded.updated_at`,
        [date, rating, line || null, now.toISOString(), t, t],
      );
      notes.appendDaily(`Rated the day ${rating}/5.${line ? ` ${line}` : ''}`, { date, now, section: REFLECTION_HEADING, replace: true });
    });
    return { date, rating, reflection: line || null };
  }

  /** Descriptive stats over the last `days` days. No causes are claimed; every figure carries its sample size. */
  function stats(opts: { days?: number; now?: Date } = {}): MomentumStats {
    const now = opts.now ?? new Date();
    const n = Math.max(1, Math.min(400, opts.days ?? 28));
    const to = momentumDay(now).date;
    const from = addDays(to, -(n - 1));
    const ch = chain({ days: n, now });
    const rows = new Map(
      db.all<{ date: string; wake_at: string | null; work_start_at: string | null; rating: number | null }>(
        'SELECT date, wake_at, work_start_at, rating FROM days WHERE date BETWEEN ? AND ?', [from, to],
      ).map((r) => [r.date, r]),
    );
    const perDay = ch.days.map((d) => ({
      date: d.date,
      focusMinutes: d.measure.focusMinutes,
      sessions: d.measure.sessions,
      met: d.met,
      wakeAt: rows.get(d.date)?.wake_at ?? null,
      workStartAt: rows.get(d.date)?.work_start_at ?? null,
      rating: d.rating,
    }));

    // Weeks start on Monday.
    const weeks = new Map<string, { focusMinutes: number; daysWithFocus: number }>();
    for (const d of perDay) {
      const dow = (new Date(`${d.date}T12:00:00`).getDay() + 6) % 7;
      const w = addDays(d.date, -dow);
      const cur = weeks.get(w) ?? { focusMinutes: 0, daysWithFocus: 0 };
      cur.focusMinutes += d.focusMinutes;
      if (d.focusMinutes > 0) cur.daysWithFocus++;
      weeks.set(w, cur);
    }

    const counts = db.all<{ kind: string; outcome: string; n: number }>(
      `SELECT kind, outcome, count(*) AS n FROM sessions WHERE ended_at IS NOT NULL AND ${DAY_OF('started_at')} BETWEEN ? AND ? GROUP BY kind, outcome`,
      [from, to],
    );
    const c = (kind: string, outcome?: string) => counts.filter((r) => r.kind === kind && (!outcome || r.outcome === outcome)).reduce((a, r) => a + r.n, 0);

    const gaps = perDay
      .filter((d) => d.wakeAt && d.workStartAt)
      .map((d) => Math.round((Date.parse(d.workStartAt!) - Date.parse(d.wakeAt!)) / 60_000))
      .filter((g) => g >= 0)
      .sort((a, b) => a - b);
    const median = gaps.length ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : Math.round((gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2)) : null;

    const buckets = ['before 9:00', '9:00–10:59', '11:00 or later', 'no session'];
    const rated = perDay.filter((d) => d.rating !== null);
    const bucketOf = (iso: string | null) => {
      if (!iso) return buckets[3];
      const h = new Date(iso).getHours();
      const hh = h < DAY_ROLLOVER_HOUR ? h + 24 : h;
      return hh < 9 ? buckets[0] : hh < 11 ? buckets[1] : buckets[2];
    };
    const ratingByStart = buckets.map((bucket) => {
      const ds = rated.filter((d) => bucketOf(d.workStartAt) === bucket);
      return { bucket, n: ds.length, avgRating: ds.length ? Math.round((ds.reduce((a, d) => a + d.rating!, 0) / ds.length) * 10) / 10 : null };
    });

    return {
      from,
      to,
      days: n,
      perDay,
      perWeek: [...weeks].map(([weekStart, w]) => ({ weekStart, ...w })),
      starters: { started: c('starter'), keptGoing: c('starter', 'continued'), stopped: c('starter', 'stopped') + c('starter', 'completed'), abandoned: c('starter', 'abandoned') },
      blocks: { started: c('focus'), completed: c('focus', 'completed'), stopped: c('focus', 'stopped'), abandoned: c('focus', 'abandoned') },
      wakeToWork: { n: gaps.length, median, min: gaps[0] ?? null, max: gaps.at(-1) ?? null },
      ratingByStart,
      daysMet: perDay.filter((d) => d.met).length,
      ratedDays: rated.length,
    };
  }

  /** One entry per day in [from, to] (default: the last 7 days), oldest first, for weekly reviews and "how did this week go". */
  function dayLog(opts: { from?: string; to?: string; now?: Date } = {}): DayLogEntry[] {
    const now = opts.now ?? new Date();
    const to = opts.to ?? momentumDay(now).date;
    const from = opts.from ?? addDays(to, -6);
    if (from > to) throw new ValidationError('from must be on or before to.');
    if (addDays(from, 366) < to) throw new ValidationError('At most a year at a time.');
    const n = Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000) + 1;
    const ch = chain({ days: n, now: new Date(`${to}T12:00:00`) });
    return ch.days.map((c) => {
      const d = days.get(c.date, now);
      const done = tasks.doneOn(c.date);
      const firstSession = db.get<{ task_id: string | null }>(
        `SELECT task_id FROM sessions WHERE ${DAY_OF('started_at')} = ? AND (outcome IS NULL OR outcome <> 'abandoned') ORDER BY started_at LIMIT 1`,
        [c.date],
      );
      return {
        date: c.date,
        wakeAt: d.wakeAt,
        workStartAt: d.workStartAt,
        wakeToWorkMinutes: d.wakeToWorkMinutes,
        // The step as planned (it may be done since), else whatever is next on the task.
        firstThing: d.firstThing
          ? {
              task: d.firstThing.task.title,
              step: db.get<{ title: string }>('SELECT st.title FROM days d JOIN subtasks st ON st.id = d.first_subtask_id WHERE d.date = ?', [c.date])?.title ?? d.firstThing.step?.title ?? null,
              taskStatus: d.firstThing.task.status,
            }
          : null,
        targetStart: d.targetStart,
        startedOnFirstThing: d.firstThing && firstSession ? firstSession.task_id === d.firstThing.task.id : null,
        minimumMet: c.met,
        measure: c.measure,
        done: { tasks: done.tasks.map((t) => t.title), steps: done.subtasks.map((s) => s.title), stepsDefined: done.stepsDefined.map((s) => s.taskTitle) },
        rating: d.rating,
        reflection: d.reflection,
        shutdown: !!d.shutdownAt,
      };
    });
  }

  return { measure, measures, chain, setMinimum, rate, stats, dayLog };
}
export type Momentum = ReturnType<typeof createMomentum>;
