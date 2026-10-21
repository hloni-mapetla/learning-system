import type { Ctx } from './context.ts';
import type { Db } from '../db.ts';
import { DEFAULT_MORNING_ROUTINE, startabilityHint, type Actor, type Day, type RoutineItem } from '../types.ts';
import type { Tasks } from './tasks.ts';
import type { Subtasks } from './subtasks.ts';
import type { Notes } from './notes.ts';
import { atLocalTime, momentumDay, newId, nowIso, NotFoundError, resolveDay, ValidationError } from '../util.ts';

export const SHUTDOWN_HEADING = 'Shutdown';

function ensureDay(db: Db, date: string): void {
  const now = nowIso();
  db.run('INSERT INTO days (date, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (date) DO NOTHING', [date, now, now]);
}

/** The morning routine's id. First use seeds the default routine; deleting every item later doesn't bring it back. */
function ensureRoutine(db: Db): string {
  const r = db.get<{ id: string }>(`SELECT id FROM routines WHERE kind = 'morning'`);
  if (r) return r.id;
  const id = newId();
  const now = nowIso();
  db.tx(() => {
    db.run(`INSERT INTO routines (id, kind, name, created_at) VALUES (?, 'morning', 'Morning routine', ?)`, [id, now]);
    DEFAULT_MORNING_ROUTINE.forEach((it, i) =>
      db.run('INSERT INTO routine_items (id, routine_id, title, optional, action, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        newId(), id, it.title, it.optional ? 1 : 0, it.action ?? null, i, now,
      ]),
    );
  });
  return id;
}

function setRoutineCheck(db: Db, date: string, action: 'wake' | 'start_first_task', at: string | null): void {
  ensureRoutine(db);
  const item = db.get<{ id: string }>(`SELECT i.id FROM routine_items i JOIN routines r ON r.id = i.routine_id WHERE r.kind = 'morning' AND i.action = ?`, [action]);
  if (!item) return;
  if (at) db.run('INSERT INTO routine_checks (date, item_id, checked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [date, item.id, at]);
  else db.run('DELETE FROM routine_checks WHERE date = ? AND item_id = ?', [date, item.id]);
}

/** Called when a session starts: the first one of the day records when work started (and ticks "Start first task"). */
export function recordWorkStart(db: Db, session: { id: string; startedAt: string }): void {
  const date = momentumDay(new Date(session.startedAt)).date;
  ensureDay(db, date);
  const r = db.run(
    `UPDATE days SET work_start_at = ?, work_start_session = ?, updated_at = ? WHERE date = ? AND work_start_at IS NULL`,
    [session.startedAt, session.id, nowIso(), date],
  );
  if (r.changes) setRoutineCheck(db, date, 'start_first_task', session.startedAt);
}

/** Called when a session is discarded: if it set the day's work start, that start didn't happen. (It's always the latest session.) */
export function forgetWorkStart(db: Db, sessionId: string): void {
  const day = db.get<{ date: string }>('SELECT date FROM days WHERE work_start_session = ?', [sessionId]);
  if (!day) return;
  db.run('UPDATE days SET work_start_at = NULL, work_start_session = NULL, updated_at = ? WHERE date = ?', [nowIso(), day.date]);
  setRoutineCheck(db, day.date, 'start_first_task', null);
}

export interface PlanInput {
  taskId: string;
  /** One of the task's open steps to start with. */
  subtaskId?: string | null;
  /** Or a new first step, added before the task's current next action. */
  stepTitle?: string | null;
  /** "HH:MM" or null. */
  targetStart?: string | null;
  /** Who wrote stepTitle (Claude saving the user's words passes 'user'); defaults to whoever is planning. */
  stepBy?: Actor;
}

/** Days (rolling over at 4am): the evening plan for tomorrow, the morning (wake, routine, first thing) and work start. */
export function createDays(ctx: Ctx, tasks: Tasks, subtasks: Subtasks, notes: Notes) {
  const { db } = ctx;

  // ---------- routine template ----------

  const routineId = () => ensureRoutine(db);

  const toItem = (r: any): RoutineItem => ({ id: r.id, title: r.title, optional: !!r.optional, action: r.action, sortOrder: r.sort_order });

  function routine(): RoutineItem[] {
    return db.all('SELECT * FROM routine_items WHERE routine_id = ? ORDER BY sort_order, created_at', [routineId()]).map(toItem);
  }

  function item(id: string): RoutineItem {
    const r = db.get('SELECT * FROM routine_items WHERE id = ?', [id]);
    if (!r) throw new NotFoundError('routine item', id);
    return toItem(r);
  }

  function renumber(order: string[]): void {
    order.forEach((id, i) => db.run('UPDATE routine_items SET sort_order = ? WHERE id = ?', [i, id]));
  }

  function addItem(title: string, opts: { optional?: boolean; position?: number } = {}): RoutineItem {
    const t = title.trim();
    if (!t) throw new ValidationError('A routine item needs some text.');
    const rid = routineId();
    const id = newId();
    db.tx(() => {
      const before = routine().map((x) => x.id);
      db.run('INSERT INTO routine_items (id, routine_id, title, optional, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id, rid, t, opts.optional ? 1 : 0, before.length, nowIso(),
      ]);
      if (opts.position !== undefined && opts.position < before.length) renumber([...before.slice(0, opts.position), id, ...before.slice(opts.position)]);
    });
    return item(id);
  }

  function updateItem(id: string, patch: { title?: string; optional?: boolean }): RoutineItem {
    const cur = item(id);
    const title = patch.title !== undefined ? patch.title.trim() : cur.title;
    if (!title) throw new ValidationError('A routine item needs some text.');
    db.run('UPDATE routine_items SET title = ?, optional = ? WHERE id = ?', [title, (patch.optional ?? cur.optional) ? 1 : 0, id]);
    return item(id);
  }

  function moveItem(id: string, delta: number): RoutineItem[] {
    item(id);
    const order = routine().map((x) => x.id);
    const i = order.indexOf(id);
    const j = Math.max(0, Math.min(order.length - 1, i + delta));
    if (i !== j) {
      order.splice(i, 1);
      order.splice(j, 0, id);
      db.tx(() => renumber(order));
    }
    return routine();
  }

  function removeItem(id: string): void {
    item(id);
    db.run('DELETE FROM routine_items WHERE id = ?', [id]);
  }

  // ---------- days ----------

  function get(spec?: string, now = new Date()): Day {
    const date = resolveDay(spec, now);
    const r = db.get<any>('SELECT * FROM days WHERE date = ?', [date]) ?? {};
    const checks = new Map(db.all<{ item_id: string; checked_at: string }>('SELECT item_id, checked_at FROM routine_checks WHERE date = ?', [date]).map((c) => [c.item_id, c.checked_at]));
    let firstThing: Day['firstThing'] = null;
    if (r.first_task_id) {
      const task = tasks.get(r.first_task_id);
      const planned = task.subtasks.find((s) => s.id === r.first_subtask_id && !s.done);
      firstThing = { task, step: planned ?? task.nextAction };
    }
    return {
      date,
      wakeAt: r.wake_at ?? null,
      workStartAt: r.work_start_at ?? null,
      workStartSessionId: r.work_start_session ?? null,
      wakeToWorkMinutes: r.wake_at && r.work_start_at ? Math.round((Date.parse(r.work_start_at) - Date.parse(r.wake_at)) / 60_000) : null,
      targetStart: r.target_start ?? null,
      plannedAt: r.planned_at ?? null,
      plannedBy: r.planned_by ?? null,
      firstThing,
      shutdownAt: r.shutdown_at ?? null,
      rating: r.rating ?? null,
      reflection: r.reflection ?? null,
      routine: routine().map((i) => ({ ...i, checkedAt: checks.get(i.id) ?? null })),
    };
  }

  const touch = (date: string, sql: string, params: unknown[]) => {
    ensureDay(db, date);
    db.run(`UPDATE days SET ${sql}, updated_at = ? WHERE date = ?`, [...params, nowIso(), date] as any);
  };

  /** Log when the user got up: now, a "HH:MM" on that day, or null to clear. Ticks the routine's "Stand up". */
  function logWake(spec?: string, at: string | Date | null = new Date(), now = new Date()): Day {
    const date = resolveDay(spec, now);
    const iso = at === null ? null : (typeof at === 'string' ? atLocalTime(date, at) : at).toISOString();
    db.tx(() => {
      touch(date, 'wake_at = ?', [iso]);
      setRoutineCheck(db, date, 'wake', iso);
    });
    return get(date, now);
  }

  /** Correct the work start by hand ("HH:MM" or null). Normally the first session of the day sets it. */
  function setWorkStart(spec: string | undefined, at: string | null, now = new Date()): Day {
    const date = resolveDay(spec, now);
    touch(date, 'work_start_at = ?, work_start_session = NULL', [at === null ? null : atLocalTime(date, at).toISOString()]);
    return get(date, now);
  }

  function setTargetStart(spec: string | undefined, hhmm: string | null, now = new Date()): Day {
    const date = resolveDay(spec, now);
    if (hhmm !== null) atLocalTime(date, hhmm);
    touch(date, 'target_start = ?', [hhmm === null ? null : hhmm.trim().padStart(5, '0')]);
    return get(date, now);
  }

  /**
   * Decide the night before: one first task for the day and its concrete first step (an open step, or a new one written now).
   * Single-step tasks need no step. Defaults to tomorrow.
   */
  function plan(spec: string | undefined, input: PlanInput, by: Actor = 'user', now = new Date()): { day: Day; hint: string | null } {
    const date = resolveDay(spec ?? 'tomorrow', now);
    let task = tasks.get(input.taskId);
    if (task.virtual) throw new ValidationError('Pick a real task; reviews show up on their own.');
    if (task.status !== 'open') throw new ValidationError(`"${task.title}" isn't open.`);
    if (input.targetStart) atLocalTime(date, input.targetStart);
    let stepId: string | null = null;
    let hint: string | null = null;
    db.tx(() => {
      if (input.stepTitle?.trim()) {
        const position = task.nextAction ? task.subtasks.indexOf(task.nextAction) : task.subtasks.length;
        const r = subtasks.add(task.id, [input.stepTitle], { position, createdBy: input.stepBy ?? by });
        stepId = r.added[0].id;
        hint = r.hints[0]?.hint ?? null;
        task = r.task;
      } else if (input.subtaskId) {
        const st = task.subtasks.find((s) => s.id === input.subtaskId);
        if (!st) throw new ValidationError("That step isn't on this task.");
        if (st.done) throw new ValidationError('That step is already done; pick the next one.');
        stepId = st.id;
      } else if (task.nextAction) {
        stepId = task.nextAction.id;
      } else if (!task.singleStep) {
        throw new ValidationError(`"${task.title}" has no steps yet. Name the first physical step (stepTitle), or mark the task single-step.`);
      }
      touch(date, 'first_task_id = ?, first_subtask_id = ?, planned_at = ?, planned_by = ?' + (input.targetStart !== undefined ? ', target_start = ?' : ''), [
        task.id, stepId, nowIso(), by, ...(input.targetStart !== undefined ? [input.targetStart ? input.targetStart.trim().padStart(5, '0') : null] : []),
      ]);
    });
    if (!hint && stepId) hint = startabilityHint(task.subtasks.find((s) => s.id === stepId)?.title ?? '');
    return { day: get(date, now), hint };
  }

  function clearPlan(spec?: string, now = new Date()): Day {
    const date = resolveDay(spec ?? 'tomorrow', now);
    touch(date, 'first_task_id = NULL, first_subtask_id = NULL, planned_at = NULL, planned_by = NULL, target_start = NULL', []);
    return get(date, now);
  }

  /** The evening shutdown: optionally note where things were left (in that day's daily note), and mark the day closed. */
  function shutdown(spec?: string, opts: { note?: string; undo?: boolean } = {}, now = new Date()): Day {
    const date = resolveDay(spec, now);
    db.tx(() => {
      if (opts.note?.trim()) notes.appendDaily(opts.note, { date, now, section: SHUTDOWN_HEADING });
      touch(date, 'shutdown_at = ?', [opts.undo ? null : now.toISOString()]);
    });
    return get(date, now);
  }

  /** Tick or untick a routine item for a day. Ticking "Stand up" also logs the wake time if it isn't logged yet. */
  function check(spec: string | undefined, itemId: string, checked: boolean, now = new Date()): Day {
    const date = resolveDay(spec, now);
    const it = item(itemId);
    db.tx(() => {
      if (checked) {
        db.run('INSERT INTO routine_checks (date, item_id, checked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [date, itemId, now.toISOString()]);
        if (it.action === 'wake' && !get(date, now).wakeAt) touch(date, 'wake_at = ?', [now.toISOString()]);
      } else {
        db.run('DELETE FROM routine_checks WHERE date = ? AND item_id = ?', [date, itemId]);
      }
    });
    return get(date, now);
  }

  /** Days with anything recorded in [from, to], newest first. */
  function list(opts: { from?: string; to?: string; limit?: number } = {}): Day[] {
    return db
      .all<{ date: string }>('SELECT date FROM days WHERE date >= ? AND date <= ? ORDER BY date DESC LIMIT ?', [opts.from ?? '0000', opts.to ?? '9999', opts.limit ?? 60])
      .map((r) => get(r.date));
  }

  return { get, list, logWake, setWorkStart, setTargetStart, plan, clearPlan, shutdown, check, routine, addItem, updateItem, moveItem, removeItem };
}
export type Days = ReturnType<typeof createDays>;
