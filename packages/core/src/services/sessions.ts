import type { Ctx } from './context.ts';
import type { Actor, Session, SessionKind, SessionOutcome, SessionState } from '../types.ts';
import type { SettingsService } from './settings.ts';
import type { Tasks } from './tasks.ts';
import type { Notes } from './notes.ts';
import { momentumDay, newId, NotFoundError, ValidationError } from '../util.ts';
import { forgetWorkStart, recordWorkStart } from './days.ts';

/** A session left running this long past its planned end (tab closed, laptop asleep) is closed as abandoned. */
export const STALE_AFTER_MINUTES = 120;

const MIN = 60_000;
export const PARKED_HEADING = 'Parked';

export interface StartSession {
  kind: SessionKind;
  taskId?: string | null;
  subtaskId?: string | null;
  /** Defaults to the starter or focus length from settings. */
  minutes?: number;
  breakMinutes?: number;
  /** The session this one carries on from (a starter that kept going, or the previous focus block). */
  continuedFrom?: string | null;
}

/** Starter sessions ("just 10 minutes") and focus blocks with a real break. One runs at a time. */
export function createSessions(ctx: Ctx, tasks: Tasks, settings: SettingsService, notes: Notes) {
  const { db } = ctx;

  function toSession(r: any): Session {
    const started = Date.parse(r.started_at);
    return {
      id: r.id,
      kind: r.kind,
      taskId: r.task_id,
      subtaskId: r.subtask_id,
      taskTitle: r.task_title,
      subtaskTitle: r.subtask_title,
      plannedMinutes: r.planned_minutes,
      breakMinutes: r.break_minutes,
      startedAt: r.started_at,
      endsAt: new Date(started + r.planned_minutes * MIN).toISOString(),
      endedAt: r.ended_at,
      outcome: r.outcome,
      actualMinutes: r.ended_at ? Math.round(((Date.parse(r.ended_at) - started) / MIN) * 10) / 10 : null,
      continuedFrom: r.continued_from,
      createdBy: r.created_by,
      subtasksCompleted: db.all<{ id: string; title: string }>(
        `SELECT DISTINCT st.id, st.title FROM task_events e JOIN subtasks st ON st.id = e.subtask_id
         WHERE e.session_id = ? AND e.type = 'subtask_done' AND st.completed_at IS NOT NULL
           AND e.rowid = (SELECT max(rowid) FROM task_events x WHERE x.subtask_id = st.id AND x.type = 'subtask_done')
         ORDER BY e.at`,
        [r.id],
      ),
    };
  }

  function get(id: string): Session {
    const r = db.get('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!r) throw new NotFoundError('session', id);
    return toSession(r);
  }

  /** Close a forgotten session as abandoned, at its planned end (we don't know when work actually stopped). */
  function closeStale(now: Date): void {
    const r = db.get<{ id: string; started_at: string; planned_minutes: number }>('SELECT * FROM sessions WHERE ended_at IS NULL');
    if (!r) return;
    const plannedEnd = Date.parse(r.started_at) + r.planned_minutes * MIN;
    if (now.getTime() > plannedEnd + STALE_AFTER_MINUTES * MIN) {
      db.run(`UPDATE sessions SET ended_at = ?, outcome = 'abandoned' WHERE id = ?`, [new Date(plannedEnd).toISOString(), r.id]);
    }
  }

  function running(now = new Date()): Session | null {
    closeStale(now);
    const r = db.get('SELECT * FROM sessions WHERE ended_at IS NULL');
    return r ? toSession(r) : null;
  }

  /** The live timer: a running session, or a break after a completed focus block. */
  function state(now = new Date()): SessionState {
    const run = running(now);
    if (run) return { running: run, onBreak: null };
    const last = db.get<any>(`SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`);
    if (last && last.kind === 'focus' && last.outcome === 'completed' && last.break_minutes > 0) {
      const until = Date.parse(last.ended_at) + last.break_minutes * MIN;
      if (now.getTime() < until) return { running: null, onBreak: { until: new Date(until).toISOString(), after: toSession(last) } };
    }
    return { running: null, onBreak: null };
  }

  function start(input: StartSession, by: Actor = 'user', now = new Date()): Session {
    const cur = running(now);
    if (cur) throw new ValidationError(`A ${cur.kind} session is already running${cur.taskTitle ? ` on "${cur.taskTitle}"` : ''}. End it first.`);
    const s = settings.get();
    let taskId = input.taskId ?? null;
    let subtaskTitle: string | null = null;
    if (input.subtaskId) {
      const st = db.get<{ task_id: string; title: string }>('SELECT task_id, title FROM subtasks WHERE id = ?', [input.subtaskId]);
      if (!st) throw new NotFoundError('subtask', input.subtaskId);
      if (taskId && taskId !== st.task_id) throw new ValidationError('That step belongs to a different task.');
      taskId = st.task_id;
      subtaskTitle = st.title;
    }
    const task = taskId ? tasks.get(taskId) : null;
    if (task?.virtual) throw new ValidationError('Start the review from the Review page instead.');
    const minutes = input.minutes ?? (input.kind === 'starter' ? s.starterMinutes : s.focusMinutes);
    if (!(minutes > 0 && minutes <= 240)) throw new ValidationError('A session lasts between 1 and 240 minutes.');
    const breakMinutes = input.kind === 'focus' ? (input.breakMinutes ?? s.breakMinutes) : 0;
    if (input.continuedFrom) get(input.continuedFrom);
    const id = newId();
    db.run(
      `INSERT INTO sessions (id, kind, task_id, subtask_id, task_title, subtask_title, planned_minutes, break_minutes, started_at, continued_from, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.kind, taskId, input.subtaskId ?? null, task?.title ?? null, subtaskTitle, minutes, breakMinutes, now.toISOString(),
        input.continuedFrom ?? null, by],
    );
    const session = get(id);
    // The first session of the day is when work started.
    recordWorkStart(db, session);
    return session;
  }

  /**
   * End the running session. Without an outcome it's decided by the clock: "completed" if the planned time ran out
   * (ended at the planned end, so time spent deciding what's next doesn't count), else "stopped" (that still counts).
   */
  function end(id: string, opts: { outcome?: 'abandoned'; now?: Date } = {}): Session {
    const now = opts.now ?? new Date();
    const cur = get(id);
    if (cur.endedAt) throw new ValidationError('That session has already ended.');
    const timeUp = now.getTime() >= Date.parse(cur.endsAt);
    const outcome: SessionOutcome = opts.outcome ?? (timeUp ? 'completed' : 'stopped');
    const at = timeUp ? cur.endsAt : now.toISOString();
    db.tx(() => {
      db.run('UPDATE sessions SET ended_at = ?, outcome = ? WHERE id = ?', [at, outcome, id]);
      if (outcome === 'abandoned') forgetWorkStart(db, id);
    });
    return get(id);
  }

  /** "Keep going": close a starter (or a finished block) and roll into a full focus block on the same work. */
  function keepGoing(id: string, by: Actor = 'user', now = new Date()): Session {
    const cur = get(id);
    if (!cur.endedAt) {
      const at = Math.min(now.getTime(), Date.parse(cur.endsAt));
      db.run(`UPDATE sessions SET ended_at = ?, outcome = 'continued' WHERE id = ?`, [new Date(at).toISOString(), id]);
    } else if (cur.kind === 'starter' && cur.outcome === 'completed') {
      db.run(`UPDATE sessions SET outcome = 'continued' WHERE id = ?`, [id]);
    }
    const task = cur.taskId ? tasks.get(cur.taskId) : null;
    // Carry on with the step that was in hand if it's still open, else the task's next action.
    const stepOpen = cur.subtaskId && task?.subtasks.some((s) => s.id === cur.subtaskId && !s.done);
    return start(
      { kind: 'focus', taskId: cur.taskId, subtaskId: stepOpen ? cur.subtaskId : (task?.nextAction?.id ?? null), continuedFrom: id },
      by,
      now,
    );
  }

  /** Sessions started in [from, to), newest first. */
  function list(opts: { from?: string; to?: string; taskId?: string; limit?: number } = {}): Session[] {
    return db
      .all(
        `SELECT * FROM sessions WHERE started_at >= :from AND started_at < :to ${opts.taskId ? 'AND task_id = :task' : ''}
         ORDER BY started_at DESC LIMIT :limit`,
        { from: opts.from ?? '0000', to: opts.to ?? '9999', task: opts.taskId, limit: opts.limit ?? 200 },
      )
      .map(toSession);
  }

  /** Parking lot: a distracting thought goes under "Parked" in today's daily note, to deal with after the block. */
  function park(text: string, now = new Date()) {
    return notes.appendDaily(text, { date: momentumDay(now).date, now, section: PARKED_HEADING });
  }

  return { get, running, state, start, end, keepGoing, list, park };
}
export type Sessions = ReturnType<typeof createSessions>;
