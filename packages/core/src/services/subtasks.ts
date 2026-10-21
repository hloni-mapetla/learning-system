import type { Ctx } from './context.ts';
import { startabilityHint, type Actor, type Subtask, type Task } from '../types.ts';
import type { SubtaskPatch } from '../schemas.ts';
import { logTaskEvent, toSubtask, type Tasks } from './tasks.ts';
import { newId, nowIso, NotFoundError, ValidationError } from '../util.ts';

export interface SubtaskResult {
  subtask: Subtask;
  task: Task;
  /** Every step is done but the task is still open: offer to complete it (never auto-complete). */
  allStepsDone: boolean;
}

export interface AddStepsResult {
  task: Task;
  added: Subtask[];
  /** Steps that look vague, with the soft hint to show. Never blocks saving. */
  hints: { subtaskId: string; title: string; hint: string }[];
  /** True when these were the task's first steps (logged as progress: "defined next steps"). */
  stepsDefined: boolean;
}

/** Ordered steps under a task (one level). The first incomplete one is the task's next action. */
export function createSubtasks(ctx: Ctx, tasks: Tasks) {
  const { db } = ctx;

  function get(id: string): Subtask {
    const r = db.get('SELECT * FROM subtasks WHERE id = ?', [id]);
    if (!r) throw new NotFoundError('subtask', id);
    return toSubtask(r);
  }

  const ids = (taskId: string) =>
    db.all<{ id: string }>('SELECT id FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at', [taskId]).map((r) => r.id);

  function renumber(taskId: string, order: string[]): void {
    const now = nowIso();
    order.forEach((id, i) => db.run('UPDATE subtasks SET sort_order = ?, updated_at = ? WHERE id = ? AND task_id = ?', [i, now, id, taskId]));
  }

  const result = (subtask: Subtask): SubtaskResult => {
    const task = tasks.get(subtask.taskId);
    return { subtask, task, allStepsDone: task.status === 'open' && task.progress.total > 0 && task.progress.done === task.progress.total };
  };

  /** Add one or more steps (in order), appended or inserted at `position`. The first steps on a task count as progress. */
  function add(taskId: string, titles: string[], opts: { position?: number; createdBy?: Actor } = {}): AddStepsResult {
    const task = tasks.get(taskId);
    if (task.virtual) throw new ValidationError("The review task can't have steps.");
    const clean = titles.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) throw new ValidationError('A step needs some text.');
    const by = opts.createdBy ?? 'user';
    const added: string[] = [];
    db.tx(() => {
      const before = ids(taskId);
      const now = nowIso();
      for (const title of clean) {
        const id = newId();
        db.run(`INSERT INTO subtasks (id, task_id, title, sort_order, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          id, taskId, title, before.length + added.length, by, now, now,
        ]);
        added.push(id);
      }
      if (opts.position !== undefined && opts.position < before.length) {
        renumber(taskId, [...before.slice(0, opts.position), ...added, ...before.slice(opts.position)]);
      }
      if (!before.length) logTaskEvent(db, { taskId, type: 'steps_defined', detail: { count: added.length }, by });
    });
    const steps = added.map(get);
    return {
      task: tasks.get(taskId),
      added: steps,
      hints: steps.flatMap((s) => {
        const hint = startabilityHint(s.title);
        return hint ? [{ subtaskId: s.id, title: s.title, hint }] : [];
      }),
      stepsDefined: task.progress.total === 0,
    };
  }

  function setDone(id: string, done: boolean, by: Actor = 'user'): SubtaskResult {
    const cur = get(id);
    if (cur.done !== done) {
      db.tx(() => {
        db.run('UPDATE subtasks SET completed_at = ?, updated_at = ? WHERE id = ?', [done ? nowIso() : null, nowIso(), id]);
        logTaskEvent(db, { taskId: cur.taskId, subtaskId: id, type: done ? 'subtask_done' : 'subtask_undone', by });
      });
    }
    return result(get(id));
  }

  function update(id: string, patch: SubtaskPatch, by: Actor = 'user'): SubtaskResult {
    const cur = get(id);
    if (patch.title !== undefined && patch.title !== cur.title) {
      db.run('UPDATE subtasks SET title = ?, updated_at = ? WHERE id = ?', [patch.title.trim(), nowIso(), id]);
    }
    if (patch.done !== undefined) return setDone(id, patch.done, by);
    return result(get(id));
  }

  /** Set the full order of a task's steps. Must list every step exactly once. */
  function reorder(taskId: string, order: string[]): Task {
    const cur = ids(taskId);
    if (order.length !== cur.length || new Set(order).size !== order.length || !order.every((id) => cur.includes(id))) {
      throw new ValidationError(`Reorder must list each of the task's ${cur.length} steps exactly once.`);
    }
    db.tx(() => renumber(taskId, order));
    return tasks.get(taskId);
  }

  /** Move one step up (-1) or down (+1). */
  function move(id: string, delta: number): Task {
    const st = get(id);
    const order = ids(st.taskId);
    const i = order.indexOf(id);
    const j = Math.max(0, Math.min(order.length - 1, i + delta));
    if (i !== j) [order[i], order[j]] = [order[j], order[i]];
    return reorder(st.taskId, order);
  }

  function remove(id: string): Task {
    const st = get(id);
    db.run('DELETE FROM subtasks WHERE id = ?', [id]);
    return tasks.get(st.taskId);
  }

  return {
    get,
    add,
    update,
    complete: (id: string, by?: Actor) => setDone(id, true, by),
    uncomplete: (id: string, by?: Actor) => setDone(id, false, by),
    reorder,
    move,
    remove,
  };
}
export type Subtasks = ReturnType<typeof createSubtasks>;
