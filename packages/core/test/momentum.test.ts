import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';
import { describeMinimum } from '../src/types.ts';

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const NOW = local(22, 20); // Thu 22 Oct, 20:00

/** A session on a given local day, ended after `minutes` (or discarded). */
function session(loom: ReturnType<typeof testLoom>, d: number, h: number, minutes: number, opts: { kind?: 'starter' | 'focus'; planned?: number; abandon?: boolean; keepGoing?: boolean } = {}) {
  const s = loom.sessions.start({ kind: opts.kind ?? 'starter', minutes: opts.planned ?? Math.max(minutes, 1) }, 'user', local(d, h));
  if (opts.keepGoing) {
    const f = loom.sessions.keepGoing(s.id, 'user', local(d, h, minutes));
    loom.sessions.end(f.id, { now: local(d, h + 1, minutes) });
    return s;
  }
  return loom.sessions.end(s.id, { outcome: opts.abandon ? 'abandoned' : undefined, now: local(d, h, minutes) });
}

describe('daily minimum and chain', () => {
  it('defaults to starting one session; a discarded one does not count; the chain counts back from today', () => {
    const loom = testLoom();
    expect(describeMinimum(loom.settings.get().dailyMinimum)).toBe('Start one session (any length)');
    session(loom, 19, 9, 3);
    session(loom, 20, 9, 10);
    session(loom, 21, 23, 5); // late evening
    session(loom, 22, 1, 4, { abandon: true }); // after midnight, still the 21st, but discarded
    const c = loom.momentum.chain({ days: 7, now: NOW });
    expect(c.days.map((d) => [d.date.slice(8), d.met])).toEqual([
      ['16', false], ['17', false], ['18', false], ['19', true], ['20', true], ['21', true], ['22', false],
    ]);
    // Today isn't over: the chain still stands at 3 until today is met.
    expect(c).toMatchObject({ current: 3, todayMet: false });
    session(loom, 22, 9, 2);
    expect(loom.momentum.chain({ days: 7, now: NOW })).toMatchObject({ current: 4, todayMet: true });
  });

  it('a session after midnight counts for the day before (4am rollover)', () => {
    const loom = testLoom();
    session(loom, 22, 1, 20);
    expect(loom.momentum.measure('2026-10-21')).toMatchObject({ sessions: 1, focusMinutes: 20 });
    expect(loom.momentum.measure('2026-10-22').sessions).toBe(0);
  });

  it('steps: ticked steps, completed tasks and defined steps all count', () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Thesis chapter 2' });
    const { added } = loom.subtasks.add(t.id, ['Outline section 2.3', 'Write the intro']);
    loom.subtasks.complete(added[0].id);
    const today = loom.momentum.chain({ days: 1 }).days[0].date;
    expect(loom.momentum.measure(today).steps).toBe(2); // defined + ticked
    loom.tasks.complete(t.id);
    expect(loom.momentum.measure(today).steps).toBe(3);
  });

  it('changing the rule keeps the verdict past days had; today follows the new rule', () => {
    const loom = testLoom();
    session(loom, 20, 9, 5);
    session(loom, 21, 9, 30);
    session(loom, 22, 9, 15);
    const c = loom.momentum.setMinimum({ kind: 'focus_minutes', value: 20 }, NOW);
    const met = Object.fromEntries(c.days.map((d) => [d.date.slice(8), [d.met, d.frozen]]));
    expect(met['20']).toEqual([true, true]); // 5 minutes met "one session" and stays met
    expect(met['21']).toEqual([true, true]);
    expect(met['22']).toEqual([false, false]); // today: 15 < 20 under the new rule
    expect(c.current).toBe(2);
    expect(() => loom.momentum.setMinimum({ kind: 'sessions', value: 0 }, NOW)).toThrow();
    // Changing again doesn't overwrite what was frozen.
    expect(loom.momentum.setMinimum({ kind: 'steps', value: 5 }, NOW).days.find((d) => d.date === '2026-10-20')!.met).toBe(true);
  });
});

describe('end-of-day rating', () => {
  it('stores the rating and note on the day and keeps one Reflection line in the daily note', () => {
    const loom = testLoom();
    loom.momentum.rate('2026-10-22', 3, 'Slow start, good afternoon', NOW);
    loom.momentum.rate('2026-10-22', 4, 'Actually decent', local(22, 21));
    expect(loom.days.get('2026-10-22')).toMatchObject({ rating: 4, reflection: 'Actually decent' });
    const body = loom.notes.daily('2026-10-22').body;
    expect(body).toMatch(/## Reflection\n\n- \*\*21:00\*\* Rated the day 4\/5\. Actually decent/);
    expect(body).not.toMatch(/3\/5/);
    expect(() => loom.momentum.rate('2026-10-22', 6)).toThrow(/1 to 5/);
  });

  it('a rating replaces the Reflection line but leaves Parked items alone', () => {
    const loom = testLoom();
    loom.notes.appendDaily('check that email', { date: '2026-10-22', now: local(22, 10), section: 'Parked' });
    loom.momentum.rate('2026-10-22', 2, '', NOW);
    loom.momentum.rate('2026-10-22', 3, '', NOW);
    const body = loom.notes.daily('2026-10-22').body;
    expect(body).toMatch(/## Parked\n\n- \*\*10:00\*\* check that email/);
    expect(body.match(/Rated the day/g)).toHaveLength(1);
  });
});

describe('momentum stats', () => {
  it('reports focus time, how sessions ended, the wake-to-work gap and rating by start time, with sample sizes', () => {
    const loom = testLoom();
    loom.days.logWake('2026-10-20', '07:00', NOW);
    session(loom, 20, 8, 10, { keepGoing: true }); // starter at 08:00 → a 45-minute block from 08:10 (completed)
    loom.days.logWake('2026-10-21', '07:30', NOW);
    session(loom, 21, 11, 4); // starter stopped after 4 minutes
    session(loom, 21, 14, 20, { kind: 'focus', planned: 45 }); // block stopped early
    session(loom, 22, 9, 2, { abandon: true });
    loom.momentum.rate('2026-10-20', 4, '', NOW);
    loom.momentum.rate('2026-10-21', 2, '', NOW);
    loom.momentum.rate('2026-10-19', 3, '', NOW);

    const s = loom.momentum.stats({ days: 7, now: NOW });
    expect(s).toMatchObject({ from: '2026-10-16', to: '2026-10-22', days: 7, daysMet: 2, ratedDays: 3 });
    expect(s.perDay.find((d) => d.date === '2026-10-20')).toMatchObject({ focusMinutes: 55, sessions: 2, met: true, rating: 4 });
    expect(s.starters).toEqual({ started: 3, keptGoing: 1, stopped: 1, abandoned: 1 });
    expect(s.blocks).toEqual({ started: 2, completed: 1, stopped: 1, abandoned: 0 });
    expect(s.wakeToWork).toEqual({ n: 2, median: 135, min: 60, max: 210 });
    expect(s.ratingByStart).toEqual([
      { bucket: 'before 9:00', n: 1, avgRating: 4 },
      { bucket: '9:00–10:59', n: 0, avgRating: null },
      { bucket: '11:00 or later', n: 1, avgRating: 2 },
      { bucket: 'no session', n: 1, avgRating: 3 },
    ]);
    // Mon 19 Oct starts the week holding 20–22 Oct.
    expect(s.perWeek.at(-1)).toEqual({ weekStart: '2026-10-19', focusMinutes: 79, daysWithFocus: 2 });
  });
});

describe('day log and task history', () => {
  it('logs each day: morning, plan, whether the first session was on the plan, minimum, done, rating', () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Thesis chapter 2', kind: 'write' });
    loom.days.plan('2026-10-21', { taskId: t.id, stepTitle: 'Open draft.docx and reread 2.3', targetStart: '08:30' }, 'user', local(20, 21));
    loom.days.logWake('2026-10-21', '07:00', NOW);
    const s = loom.sessions.start({ kind: 'starter', taskId: t.id }, 'user', local(21, 8, 40));
    loom.sessions.end(s.id, { now: local(21, 8, 50) });
    loom.subtasks.complete(loom.tasks.get(t.id).subtasks[0].id);
    loom.momentum.rate('2026-10-21', 4, 'Started on time', NOW);
    const other = loom.tasks.create({ title: 'Grant report' });
    loom.days.plan('2026-10-22', { taskId: other.id, stepTitle: 'Open last year PDF' }, 'user', local(21, 21));
    loom.sessions.start({ kind: 'starter', taskId: t.id }, 'user', local(22, 9));

    const log = loom.momentum.dayLog({ now: NOW });
    expect(log.map((d) => d.date)).toEqual(['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
    expect(log[5]).toMatchObject({
      wakeToWorkMinutes: 100,
      firstThing: { task: 'Thesis chapter 2', step: 'Open draft.docx and reread 2.3', taskStatus: 'open' },
      targetStart: '08:30',
      startedOnFirstThing: true,
      minimumMet: true,
      rating: 4,
      reflection: 'Started on time',
    });
    expect(log[6]).toMatchObject({ startedOnFirstThing: false, minimumMet: true });
    expect(log[0]).toMatchObject({ firstThing: null, startedOnFirstThing: null, minimumMet: false });
    expect(() => loom.momentum.dayLog({ from: '2026-10-22', to: '2026-10-01' })).toThrow();
  });

  it('counts reschedules and sessions per task', () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Tax return', dueDate: '2026-10-20' });
    loom.tasks.update(t.id, { dueDate: '2026-10-22' });
    loom.tasks.update(t.id, { dueDate: '2026-10-25' }, 'claude');
    loom.tasks.update(t.id, { priority: 1 }); // not a move
    expect(loom.tasks.get(t.id).timesRescheduled).toBe(2);
    expect(loom.tasks.list({ view: 'all_open' }).find((x) => x.id === t.id)!.timesRescheduled).toBe(2);
    const s = loom.sessions.start({ kind: 'starter', taskId: t.id }, 'user', local(22, 9));
    loom.sessions.end(s.id, { now: local(22, 9, 6) });
    const h = loom.tasks.history(t.id);
    expect(h.rescheduled).toEqual([
      expect.objectContaining({ from: '2026-10-20', to: '2026-10-22', by: 'user' }),
      expect.objectContaining({ from: '2026-10-22', to: '2026-10-25', by: 'claude' }),
    ]);
    expect(h.sessions).toMatchObject({ count: 1, minutes: 6 });
  });
});
