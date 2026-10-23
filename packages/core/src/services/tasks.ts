import type { Ctx } from './context.ts';
import { STEP_KINDS, type Actor, type DoneToday, type Subtask, type Task, type TaskHistory } from '../types.ts';
import type { TaskCreate, TaskPatch } from '../schemas.ts';
import type { Review } from './review.ts';
import type { Db } from '../db.ts';
import { localDate, momentumDay, newId, nowIso, NotFoundError } from '../util.ts';

export type TaskEventType = 'steps_defined' | 'subtask_done' | 'subtask_undone' | 'task_done' | 'task_reopened' | 'rescheduled';

/** Append to the task event log (progress, the done list, and how often a task gets moved). */
export function logTaskEvent(
  db: Db,
  e: { taskId: string; type: TaskEventType; subtaskId?: string | null; detail?: unknown; by?: Actor; at?: string },
): void {
  // Anything done while a session is running is credited to that session.
  db.run(
    `INSERT INTO task_events (id, task_id, subtask_id, type, detail, created_by, at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT id FROM sessions WHERE ended_at IS NULL))`,
    [newId(), e.taskId, e.subtaskId ?? null, e.type, e.detail === undefined ? null : JSON.stringify(e.detail), e.by ?? 'user', e.at ?? nowIso()],
  );
}

export function toSubtask(r: any): Subtask {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    done: !!r.completed_at,
    completedAt: r.completed_at,
    sortOrder: r.sort_order,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Attach steps, progress, next action and the "needs a first step" flag. */
function withSteps(t: Omit<Task, 'subtasks' | 'progress' | 'nextAction' | 'needsFirstStep' | 'timesRescheduled'>, steps: Subtask[], timesRescheduled = 0): Task {
  const done = steps.filter((x) => x.done).length;
  return {
    ...t,
    subtasks: steps,
    timesRescheduled,
    progress: { done, total: steps.length },
    nextAction: steps.find((x) => !x.done) ?? null,
    needsFirstStep:
      t.status === 'open' && !t.virtual && !t.singleStep && !steps.length && (STEP_KINDS as readonly string[]).includes(t.kind),
  };
}

function toTask(r: any) {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    details: r.details,
    sourceId: r.source_id,
    sourceTitle: r.source_title ?? null,
    noteId: r.note_id,
    dueDate: r.due_date,
    priority: r.priority,
    status: r.status,
    completedAt: r.completed_at,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    createdBy: r.created_by as Actor,
    singleStep: !!r.single_step,
  };
}

const SELECT = `SELECT t.*, s.title AS source_title FROM tasks t LEFT JOIN sources s ON s.id = t.source_id`;
export const REVIEW_TASK_ID = 'review-today';

export interface CompleteResult {
  task: Task;
  /** What to do next. Finishing a reading task asks for a blank-page recall before any highlights are looked at. */
  followUp: { action: 'blank_page_recall'; sourceId: string | null; sourceTitle: string | null; message: string } | null;
}

export interface TaskListOpts {
  view?: 'today' | 'upcoming' | 'all_open' | 'done';
  sourceId?: string;
  includeReview?: boolean;
  limit?: number;
}

export function createTasks(ctx: Ctx, review: Review) {
  const { db } = ctx;

  /** Rows → tasks, loading every task's steps in one query. */
  function hydrate(rows: any[]): Task[] {
    if (!rows.length) return [];
    const steps = new Map<string, Subtask[]>();
    for (const r of db.all(`SELECT * FROM subtasks WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order, created_at`, [
      JSON.stringify(rows.map((r) => r.id)),
    ])) {
      const st = toSubtask(r);
      steps.set(st.taskId, [...(steps.get(st.taskId) ?? []), st]);
    }
    const moved = new Map(
      db.all<{ task_id: string; n: number }>(
        `SELECT task_id, count(*) AS n FROM task_events WHERE type = 'rescheduled' AND task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id`,
        [JSON.stringify(rows.map((r) => r.id))],
      ).map((r) => [r.task_id, r.n]),
    );
    return rows.map((r) => withSteps(toTask(r), steps.get(r.id) ?? [], moved.get(r.id) ?? 0));
  }

  function get(id: string): Task {
    const r = db.get(`${SELECT} WHERE t.id = ?`, [id]);
    if (!r) throw new NotFoundError('task', id);
    return hydrate([r])[0];
  }

  function create(input: TaskCreate, createdBy: Actor = 'user'): Task {
    const id = newId();
    const now = nowIso();
    const max = db.get<{ m: number | null }>(`SELECT max(sort_order) AS m FROM tasks WHERE status = 'open'`)!.m ?? 0;
    db.run(
      `INSERT INTO tasks (id, title, kind, details, source_id, note_id, due_date, priority, sort_order, single_step, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title.trim(), input.kind ?? 'todo', input.details ?? '', input.sourceId ?? null, input.noteId ?? null,
        input.dueDate ?? null, input.priority ?? 3, max + 1, input.singleStep ? 1 : 0, createdBy, now, now],
    );
    return get(id);
  }

  function update(id: string, patch: TaskPatch, by: Actor = 'user'): Task {
    const cur = get(id);
    const status = patch.status ?? cur.status;
    const dueDate = patch.dueDate !== undefined ? patch.dueDate : cur.dueDate;
    db.tx(() => {
      // Moving a dated task (to another date, or off the calendar) is what "keeps getting moved" counts.
      if (cur.dueDate && dueDate !== cur.dueDate && cur.status === 'open') {
        logTaskEvent(db, { taskId: id, type: 'rescheduled', detail: { from: cur.dueDate, to: dueDate }, by });
      }
      if (status !== cur.status && (status === 'done' || cur.status === 'done')) {
        logTaskEvent(db, { taskId: id, type: status === 'done' ? 'task_done' : 'task_reopened', by });
      }
      db.run(
        `UPDATE tasks SET title = ?, kind = ?, details = ?, source_id = ?, note_id = ?, due_date = ?, priority = ?, status = ?,
           completed_at = ?, sort_order = ?, single_step = ?, updated_at = ? WHERE id = ?`,
        [
          patch.title ?? cur.title,
          patch.kind ?? cur.kind,
          patch.details ?? cur.details,
          patch.sourceId !== undefined ? patch.sourceId : cur.sourceId,
          patch.noteId !== undefined ? patch.noteId : cur.noteId,
          dueDate,
          patch.priority ?? cur.priority,
          status,
          status === 'done' ? (cur.completedAt ?? nowIso()) : null,
          patch.sortOrder ?? cur.sortOrder,
          (patch.singleStep ?? cur.singleStep) ? 1 : 0,
          nowIso(),
          id,
        ],
      );
    });
    return get(id);
  }

  /** Mark done. Finishing a reading task prompts a blank-page recall and moves the source along. */
  function complete(id: string, by: Actor = 'user'): CompleteResult {
    const task = update(id, { status: 'done' }, by);
    let followUp: CompleteResult['followUp'] = null;
    if (task.kind === 'read') {
      followUp = {
        action: 'blank_page_recall',
        sourceId: task.sourceId,
        sourceTitle: task.sourceTitle,
        message: `You finished "${task.title}". Before you look at anything: what do you remember? Write it down from memory first; highlights come after.`,
      };
      if (task.sourceId) {
        const s = db.get<{ status: string }>('SELECT status FROM sources WHERE id = ?', [task.sourceId]);
        if (s?.status === 'queued') {
          db.run(`UPDATE sources SET status = 'reading', started_at = coalesce(started_at, ?), updated_at = ? WHERE id = ?`, [
            localDate(),
            nowIso(),
            task.sourceId,
          ]);
        }
      }
    }
    return { task, followUp };
  }

  function remove(id: string): void {
    if (!db.run('DELETE FROM tasks WHERE id = ?', [id]).changes) throw new NotFoundError('task', id);
  }

  /** The computed "review today's cards" task, or null if nothing is due. */
  function reviewTask(now = new Date()): Task | null {
    const c = review.counts({ now });
    if (!c.total) return null;
    const parts = [c.review && `${c.review} review`, c.learning && `${c.learning} learning`, c.new && `${c.new} new`].filter(Boolean);
    return withSteps({
      id: REVIEW_TASK_ID,
      title: `Review ${c.total} due card${c.total === 1 ? '' : 's'}`,
      kind: 'todo',
      details: parts.join(' · '),
      sourceId: null,
      sourceTitle: null,
      noteId: null,
      dueDate: localDate(now),
      priority: 1,
      status: 'open',
      completedAt: null,
      sortOrder: -1,
      createdAt: now.toISOString(),
      createdBy: 'system',
      singleStep: true,
      virtual: true,
    }, []);
  }

  /**
   * today: open tasks due today or overdue, plus undated high-priority ones, plus today's review task.
   * upcoming: open tasks with a future due date. all_open: everything open. done: recently completed.
   */
  function list(opts: TaskListOpts = {}): Task[] {
    const today = localDate();
    const view = opts.view ?? 'all_open';
    const src = opts.sourceId ? ' AND t.source_id = :src' : '';
    const p = { today, src: opts.sourceId, limit: opts.limit ?? 500 };
    const order = 'ORDER BY t.due_date IS NULL, t.due_date, t.priority, t.sort_order';
    let rows: any[];
    if (view === 'today') {
      rows = db.all(
        `${SELECT} WHERE t.status = 'open' AND (t.due_date <= :today OR (t.due_date IS NULL AND t.priority = 1))${src} ${order} LIMIT :limit`,
        p,
      );
    } else if (view === 'upcoming') {
      rows = db.all(`${SELECT} WHERE t.status = 'open' AND t.due_date > :today${src} ${order} LIMIT :limit`, p);
    } else if (view === 'done') {
      rows = db.all(`${SELECT} WHERE t.status = 'done'${src} ORDER BY t.completed_at DESC LIMIT :limit`, p);
    } else {
      rows = db.all(`${SELECT} WHERE t.status = 'open'${src} ${order} LIMIT :limit`, p);
    }
    const tasks = hydrate(rows);
    if ((view === 'today' || view === 'all_open') && opts.includeReview !== false && !opts.sourceId) {
      const rt = reviewTask();
      if (rt) tasks.unshift(rt);
    }
    return tasks;
  }

  /** Reading queue: sources being read or queued, by priority, with their open tasks. */
  function readingQueue() {
    const sources = db.all<{ id: string; title: string; authors: string; kind: string; status: string; priority: number; started_at: string | null; notes: number }>(
      `SELECT s.id, s.title, s.authors, s.kind, s.status, s.priority, s.started_at,
         (SELECT count(*) FROM notes n WHERE n.source_id = s.id) AS notes
       FROM sources s WHERE s.status IN ('reading', 'queued')
       ORDER BY s.status = 'queued', s.priority, s.created_at`,
    );
    return sources.map((s) => ({
      ...s,
      openTasks: hydrate(db.all(`${SELECT} WHERE t.status = 'open' AND t.source_id = ? ORDER BY t.sort_order`, [s.id])),
    }));
  }

  /** A task's history: each move of its due date, the sessions spent on it, and when its steps were first defined. */
  function history(id: string): TaskHistory {
    const t = get(id);
    const s = db.get<{ n: number; minutes: number | null; last: string | null }>(
      `SELECT count(*) AS n, sum((julianday(coalesce(ended_at, started_at)) - julianday(started_at)) * 1440) AS minutes, max(started_at) AS last
       FROM sessions WHERE task_id = ? AND (outcome IS NULL OR outcome <> 'abandoned')`,
      [id],
    )!;
    return {
      taskId: id,
      createdAt: t.createdAt,
      rescheduled: db
        .all<{ detail: string; at: string; created_by: Actor }>(`SELECT detail, at, created_by FROM task_events WHERE task_id = ? AND type = 'rescheduled' ORDER BY at`, [id])
        .map((e) => ({ ...(JSON.parse(e.detail) as { from: string | null; to: string | null }), at: e.at, by: e.created_by })),
      sessions: { count: s.n, minutes: Math.round(s.minutes ?? 0), lastAt: s.last },
      stepsDefinedAt: db.get<{ at: string }>(`SELECT min(at) AS at FROM task_events WHERE task_id = ? AND type = 'steps_defined'`, [id])?.at ?? null,
    };
  }

  /** What got done today (the day rolls over at 4am): tasks, steps, tasks whose first steps were defined, and sessions. */
  function doneToday(now = new Date()): DoneToday {
    return doneOn(momentumDay(now).date);
  }

  /** What got done on a momentum date (YYYY-MM-DD). */
  function doneOn(date: string): DoneToday {
    const d = momentumDay(new Date(`${date}T12:00:00`));
    const p = { start: d.start.toISOString(), end: d.end.toISOString() };
    return {
      date: d.date,
      tasks: db.all<{ id: string; title: string; at: string }>(
        `SELECT id, title, completed_at AS at FROM tasks WHERE status = 'done' AND completed_at >= :start AND completed_at < :end ORDER BY completed_at`,
        p,
      ),
      subtasks: db.all<{ id: string; title: string; taskId: string; taskTitle: string; at: string }>(
        `SELECT st.id, st.title, st.task_id AS taskId, t.title AS taskTitle, st.completed_at AS at
         FROM subtasks st JOIN tasks t ON t.id = st.task_id
         WHERE st.completed_at >= :start AND st.completed_at < :end ORDER BY st.completed_at`,
        p,
      ),
      stepsDefined: db.all<{ taskId: string; taskTitle: string; at: string }>(
        `SELECT e.task_id AS taskId, t.title AS taskTitle, max(e.at) AS at
         FROM task_events e JOIN tasks t ON t.id = e.task_id
         WHERE e.type = 'steps_defined' AND e.at >= :start AND e.at < :end GROUP BY e.task_id ORDER BY at`,
        p,
      ),
      sessions: db.all<DoneToday['sessions'][number]>(
        `SELECT id, kind, task_title AS taskTitle, round((julianday(ended_at) - julianday(started_at)) * 1440, 1) AS minutes, outcome,
           started_at AS at
         FROM sessions WHERE ended_at IS NOT NULL AND outcome <> 'abandoned' AND started_at >= :start AND started_at < :end ORDER BY started_at`,
        p,
      ),
    };
  }

  return { get, create, update, complete, remove, list, reviewTask, readingQueue, doneToday, doneOn, history, hydrate };
}
export type Tasks = ReturnType<typeof createTasks>;
