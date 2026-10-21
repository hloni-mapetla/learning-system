import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';
import { localDate, momentumDay, startabilityHint, STARTABILITY_HINT } from '../src/index.ts';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDate(d);
};

describe('subtasks and next actions', () => {
  it('adds ordered steps; the first incomplete one is the next action', () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Thesis chapter 2' });
    expect(t).toMatchObject({ subtasks: [], progress: { done: 0, total: 0 }, nextAction: null, needsFirstStep: true, createdBy: 'user' });

    const r = loom.subtasks.add(t.id, ['Open draft, reread §2.3', 'Write 3 bullets on what is missing', 'Email Sam the bullets']);
    expect(r.stepsDefined).toBe(true);
    expect(r.task.progress).toEqual({ done: 0, total: 3 });
    expect(r.task.nextAction!.title).toBe('Open draft, reread §2.3');
    expect(r.task.needsFirstStep).toBe(false);

    const c = loom.subtasks.complete(r.added[0].id);
    expect(c.task.progress).toEqual({ done: 1, total: 3 });
    expect(c.task.nextAction!.title).toBe('Write 3 bullets on what is missing');
    expect(c.allStepsDone).toBe(false);

    // A later batch doesn't count as "defining" again, and can be inserted at a position.
    const more = loom.subtasks.add(t.id, ['Make tea'], { position: 0 });
    expect(more.stepsDefined).toBe(false);
    expect(more.task.subtasks.map((s) => s.title)[0]).toBe('Make tea');
    expect(more.task.nextAction!.title).toBe('Make tea');
  });

  it('offers, but never forces, completing the task when every step is done', () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Tax return' });
    const { added } = loom.subtasks.add(t.id, ['Download the P60 PDF', 'Fill in box 1 to 5']);
    loom.subtasks.complete(added[0].id);
    const r = loom.subtasks.complete(added[1].id);
    expect(r.allStepsDone).toBe(true);
    expect(r.task.status).toBe('open');
    expect(r.task.nextAction).toBeNull();
    expect(loom.subtasks.uncomplete(added[1].id)).toMatchObject({ allStepsDone: false, subtask: { done: false, completedAt: null } });
    loom.subtasks.complete(added[1].id);
    loom.tasks.complete(t.id);
    expect(loom.subtasks.complete(added[1].id).allStepsDone).toBe(false); // task already done: nothing to offer
  });

  it('edits, reorders, moves and removes steps', () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Clean garage' });
    const [a, b, c] = loom.subtasks.add(t.id, ['Carry bikes outside', 'Sweep the floor', 'Bag the old paint tins']).added;
    expect(loom.subtasks.update(b.id, { title: 'Sweep the floor with the big broom' }).subtask.title).toBe('Sweep the floor with the big broom');
    expect(loom.subtasks.update(c.id, { done: true }).subtask.done).toBe(true);
    expect(loom.subtasks.reorder(t.id, [c.id, a.id, b.id]).subtasks.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
    expect(() => loom.subtasks.reorder(t.id, [a.id, b.id])).toThrow(/exactly once/);
    expect(() => loom.subtasks.reorder(t.id, [a.id, a.id, b.id])).toThrow(/exactly once/);
    expect(loom.subtasks.move(b.id, -1).subtasks.map((s) => s.id)).toEqual([c.id, b.id, a.id]);
    expect(loom.subtasks.move(c.id, -1).subtasks.map((s) => s.id)).toEqual([c.id, b.id, a.id]); // already first
    expect(loom.subtasks.remove(b.id).subtasks.map((s) => s.id)).toEqual([c.id, a.id]);
    expect(() => loom.subtasks.add(t.id, ['  '])).toThrow(/needs some text/);
    loom.tasks.remove(t.id);
    expect(loom.db.get<{ n: number }>('SELECT count(*) AS n FROM subtasks')!.n).toBe(0); // cascades
  });

  it('flags "needs a first step" only for open to-do/write/summarize tasks without steps or the single-step mark', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'Book' });
    expect(loom.tasks.create({ title: 'Plan the essay', kind: 'write' }).needsFirstStep).toBe(true);
    expect(loom.tasks.create({ title: 'Summary of Book', kind: 'summarize' }).needsFirstStep).toBe(true);
    expect(loom.tasks.create({ title: 'Read ch 4', kind: 'read', sourceId: s.id }).needsFirstStep).toBe(false);
    expect(loom.tasks.create({ title: 'Process it', kind: 'process_highlights' }).needsFirstStep).toBe(false);
    const small = loom.tasks.create({ title: 'Call the dentist', singleStep: true });
    expect(small).toMatchObject({ singleStep: true, needsFirstStep: false });
    expect(loom.tasks.update(small.id, { singleStep: false }).needsFirstStep).toBe(true);
    const done = loom.tasks.create({ title: 'Old thing' });
    expect(loom.tasks.complete(done.id).task.needsFirstStep).toBe(false);
    loom.cards.create({ type: 'basic', front: 'q', back: 'a' });
    expect(loom.tasks.reviewTask()).toMatchObject({ virtual: true, needsFirstStep: false, subtasks: [] });
    expect(() => loom.subtasks.add('review-today', ['x'])).toThrow();
  });

  it("lists steps on every task in a list, and records who wrote them", () => {
    const loom = testLoom();
    const t1 = loom.tasks.create({ title: 'A', dueDate: day(0) });
    const t2 = loom.tasks.create({ title: 'B', dueDate: day(0) }, 'claude');
    loom.subtasks.add(t1.id, ['Open the file and read the intro']);
    loom.subtasks.add(t2.id, ['Write the opening sentence', 'List three sources'], { createdBy: 'claude' });
    const [a, b] = loom.tasks.list({ view: 'today' });
    expect(a.subtasks.map((s) => s.createdBy)).toEqual(['user']);
    expect(b).toMatchObject({ createdBy: 'claude', progress: { total: 2 } });
    expect(b.subtasks.every((s) => s.createdBy === 'claude')).toBe(true);
  });

  it("builds today's done list: tasks, steps, and defined steps", () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Write report' });
    const { added } = loom.subtasks.add(t.id, ['Open the template doc', 'Paste last week numbers']);
    loom.subtasks.complete(added[0].id);
    const other = loom.tasks.create({ title: 'Book flights', singleStep: true });
    loom.tasks.complete(other.id);
    const d = loom.tasks.doneToday();
    expect(d.date).toBe(momentumDay().date);
    expect(d.tasks.map((x) => x.title)).toEqual(['Book flights']);
    expect(d.subtasks).toEqual([expect.objectContaining({ title: 'Open the template doc', taskTitle: 'Write report' })]);
    expect(d.stepsDefined).toEqual([expect.objectContaining({ taskId: t.id, taskTitle: 'Write report' })]);
    loom.subtasks.uncomplete(added[0].id);
    expect(loom.tasks.doneToday().subtasks).toEqual([]); // the done list reflects current state
  });

  it('logs reschedules of dated tasks, and completions, to the event log', () => {
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Dentist forms', dueDate: day(0) });
    loom.tasks.update(t.id, { dueDate: day(1) });
    loom.tasks.update(t.id, { dueDate: day(3) }, 'claude');
    loom.tasks.update(t.id, { priority: 2 }); // not a move
    const undated = loom.tasks.create({ title: 'Someday' });
    loom.tasks.update(undated.id, { dueDate: day(2) }); // scheduling, not moving
    loom.tasks.complete(t.id);
    loom.tasks.update(t.id, { status: 'open' });
    const ev = loom.db.all<{ task_id: string; type: string; detail: string | null; created_by: string }>(
      'SELECT task_id, type, detail, created_by FROM task_events ORDER BY at, rowid',
    );
    expect(ev.map((e) => [e.task_id === t.id ? 't' : 'u', e.type, e.created_by])).toEqual([
      ['t', 'rescheduled', 'user'],
      ['t', 'rescheduled', 'claude'],
      ['t', 'task_done', 'user'],
      ['t', 'task_reopened', 'user'],
    ]);
    expect(JSON.parse(ev[1].detail!)).toEqual({ from: day(1), to: day(3) });
  });
});

describe('startability hint', () => {
  it('nudges vague steps and leaves concrete ones alone', () => {
    for (const s of ['work on thesis', 'Finish chapter', 'do it', 'Deal with email', 'handle taxes', 'stuff']) {
      expect(startabilityHint(s)).toBe(STARTABILITY_HINT);
    }
    for (const s of ['Open draft and reread §2.3', 'Write 3 bullets on what is missing', 'Email Sam the outline', '']) {
      expect(startabilityHint(s)).toBeNull();
    }
  });
});

describe('momentum day', () => {
  it('rolls over at 4am', () => {
    expect(momentumDay(new Date(2026, 9, 20, 0, 30)).date).toBe('2026-10-19');
    expect(momentumDay(new Date(2026, 9, 20, 4, 0)).date).toBe('2026-10-20');
    const d = momentumDay(new Date(2026, 9, 20, 23, 0));
    expect([d.start.getHours(), d.end.getDate()]).toEqual([4, 21]);
  });
});

describe('export', () => {
  it('includes steps and task events in JSON and a task checklist in the Markdown vault', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const loom = testLoom();
    const t = loom.tasks.create({ title: 'Write essay', kind: 'write' });
    const { added } = loom.subtasks.add(t.id, ['Open the outline doc', 'Write the first paragraph'], { createdBy: 'claude' });
    loom.subtasks.complete(added[0].id);
    const j = loom.exporter.json() as any;
    expect(j.subtasks).toHaveLength(2);
    expect(j.task_events.map((e: any) => e.type).sort()).toEqual(['steps_defined', 'subtask_done']);
    const dir = mkdtempSync(join(tmpdir(), 'loom-vault-'));
    loom.exporter.markdownVault(dir);
    const md = readFileSync(join(dir, '_tasks.md'), 'utf8');
    expect(md).toContain('- [ ] Write essay _(write · P3)_');
    expect(md).toContain('    - [x] Open the outline doc _(by claude)_');
    expect(md).toContain('    - [ ] Write the first paragraph');
  });
});
