import type { Ctx } from './context.ts';
import type { Task } from '../types.ts';
import type { TaskCreate, TaskPatch } from '../schemas.ts';
import type { Review } from './review.ts';
import { localDate, newId, nowIso, NotFoundError } from '../util.ts';

function toTask(r: any): Task {
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
  };
}

const SELECT = `SELECT t.*, s.title AS source_title FROM tasks t LEFT JOIN sources s ON s.id = t.source_id`;
export const REVIEW_TASK_ID = 'review-today';

export interface CompleteResult {
  task: Task;
  /** What the user (or Claude) should do next, e.g. capture highlights after finishing a reading task. */
  followUp: { action: 'capture_highlights'; sourceId: string | null; sourceTitle: string | null; message: string } | null;
}

export interface TaskListOpts {
  view?: 'today' | 'upcoming' | 'all_open' | 'done';
  sourceId?: string;
  includeReview?: boolean;
  limit?: number;
}

export function createTasks(ctx: Ctx, review: Review) {
  const { db } = ctx;

  function get(id: string): Task {
    const r = db.get(`${SELECT} WHERE t.id = ?`, [id]);
    if (!r) throw new NotFoundError('task', id);
    return toTask(r);
  }

  function create(input: TaskCreate): Task {
    const id = newId();
    const now = nowIso();
    const max = db.get<{ m: number | null }>(`SELECT max(sort_order) AS m FROM tasks WHERE status = 'open'`)!.m ?? 0;
    db.run(
      `INSERT INTO tasks (id, title, kind, details, source_id, note_id, due_date, priority, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title.trim(), input.kind ?? 'todo', input.details ?? '', input.sourceId ?? null, input.noteId ?? null,
        input.dueDate ?? null, input.priority ?? 3, max + 1, now, now],
    );
    return get(id);
  }

  function update(id: string, patch: TaskPatch): Task {
    const cur = get(id);
    const status = patch.status ?? cur.status;
    db.run(
      `UPDATE tasks SET title = ?, kind = ?, details = ?, source_id = ?, note_id = ?, due_date = ?, priority = ?, status = ?,
         completed_at = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
      [
        patch.title ?? cur.title,
        patch.kind ?? cur.kind,
        patch.details ?? cur.details,
        patch.sourceId !== undefined ? patch.sourceId : cur.sourceId,
        patch.noteId !== undefined ? patch.noteId : cur.noteId,
        patch.dueDate !== undefined ? patch.dueDate : cur.dueDate,
        patch.priority ?? cur.priority,
        status,
        status === 'done' ? (cur.completedAt ?? nowIso()) : null,
        patch.sortOrder ?? cur.sortOrder,
        nowIso(),
        id,
      ],
    );
    return get(id);
  }

  /** Mark done. Finishing a reading task prompts capturing notes and moves the source along. */
  function complete(id: string): CompleteResult {
    const task = update(id, { status: 'done' });
    let followUp: CompleteResult['followUp'] = null;
    if (task.kind === 'read') {
      followUp = {
        action: 'capture_highlights',
        sourceId: task.sourceId,
        sourceTitle: task.sourceTitle,
        message: `You finished "${task.title}". Capture your highlights and key ideas while they're fresh${
          task.sourceTitle ? ` (paste them, import Kindle clippings, or add them on the ${task.sourceTitle} page)` : ''
        }.`,
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
    return {
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
      virtual: true,
    };
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
    const tasks = rows.map(toTask);
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
      openTasks: db.all(`${SELECT} WHERE t.status = 'open' AND t.source_id = ? ORDER BY t.sort_order`, [s.id]).map(toTask),
    }));
  }

  return { get, create, update, complete, remove, list, reviewTask, readingQueue };
}
export type Tasks = ReturnType<typeof createTasks>;
