import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';

const at = (iso: string) => new Date(iso);
const T0 = '2026-10-21T08:00:00.000Z';
const plus = (min: number) => new Date(Date.parse(T0) + min * 60_000);

function setup() {
  const loom = testLoom();
  const task = loom.tasks.create({ title: 'Thesis chapter 2' });
  const { added } = loom.subtasks.add(task.id, ['Open draft and reread section 2.3', 'Write 3 bullets on what is missing']);
  return { loom, task, steps: added };
}

describe('sessions', () => {
  it('starts a starter on a step with settings defaults, and only one at a time', () => {
    const { loom, task, steps } = setup();
    const s = loom.sessions.start({ kind: 'starter', subtaskId: steps[0].id }, 'user', at(T0));
    expect(s).toMatchObject({
      kind: 'starter', taskId: task.id, taskTitle: 'Thesis chapter 2', subtaskTitle: 'Open draft and reread section 2.3',
      plannedMinutes: 10, breakMinutes: 0, endsAt: plus(10).toISOString(), outcome: null, endedAt: null,
    });
    expect(() => loom.sessions.start({ kind: 'focus' }, 'user', plus(1))).toThrow(/already running/);
    expect(loom.sessions.state(plus(2)).running!.id).toBe(s.id);
  });

  it('a starter that ran out and then stopped counts as completed, ended at its planned end', () => {
    const { loom, task } = setup();
    const s = loom.sessions.start({ kind: 'starter', taskId: task.id }, 'user', at(T0));
    const e = loom.sessions.end(s.id, { now: plus(13) }); // 3 minutes deciding don't count
    expect(e).toMatchObject({ outcome: 'completed', endedAt: plus(10).toISOString(), actualMinutes: 10 });
    expect(() => loom.sessions.end(s.id)).toThrow(/already ended/);
  });

  it('stopping early is "stopped" (it still counts); discarding is "abandoned"', () => {
    const { loom } = setup();
    const a = loom.sessions.start({ kind: 'starter', minutes: 5 }, 'user', at(T0));
    expect(loom.sessions.end(a.id, { now: plus(3) })).toMatchObject({ outcome: 'stopped', actualMinutes: 3 });
    const b = loom.sessions.start({ kind: 'focus' }, 'user', plus(4));
    expect(loom.sessions.end(b.id, { outcome: 'abandoned', now: plus(6) }).outcome).toBe('abandoned');
  });

  it('"keep going" turns a starter into a full focus block on the same step, linked to it', () => {
    const { loom, steps } = setup();
    loom.settings.set({ focusMinutes: 30, breakMinutes: 5 });
    const s = loom.sessions.start({ kind: 'starter', subtaskId: steps[0].id }, 'user', at(T0));
    const f = loom.sessions.keepGoing(s.id, 'user', plus(11));
    expect(loom.sessions.get(s.id)).toMatchObject({ outcome: 'continued', endedAt: plus(10).toISOString() });
    expect(f).toMatchObject({ kind: 'focus', plannedMinutes: 30, breakMinutes: 5, continuedFrom: s.id, subtaskId: steps[0].id, startedAt: plus(11).toISOString() });
  });

  it('keep going moves on to the next action when the step in hand was finished', () => {
    const { loom, steps } = setup();
    const s = loom.sessions.start({ kind: 'starter', subtaskId: steps[0].id }, 'user', at(T0));
    loom.subtasks.complete(steps[0].id);
    loom.sessions.end(s.id, { now: plus(10) });
    expect(loom.sessions.keepGoing(s.id, 'user', plus(12)).subtaskId).toBe(steps[1].id);
    expect(loom.sessions.get(s.id).outcome).toBe('continued');
  });

  it('a completed focus block is followed by a real break; the next block is opt-in', () => {
    const { loom, task } = setup();
    const f = loom.sessions.start({ kind: 'focus', taskId: task.id }, 'user', at(T0));
    expect(f).toMatchObject({ plannedMinutes: 45, breakMinutes: 10 });
    loom.sessions.end(f.id, { now: plus(45) });
    expect(loom.sessions.state(plus(50))).toMatchObject({ running: null, onBreak: { until: plus(55).toISOString(), after: { id: f.id } } });
    expect(loom.sessions.state(plus(56))).toEqual({ running: null, onBreak: null });
    // Stopping early means no announced break.
    const g = loom.sessions.start({ kind: 'focus' }, 'user', plus(60));
    loom.sessions.end(g.id, { now: plus(70) });
    expect(loom.sessions.state(plus(71)).onBreak).toBeNull();
  });

  it('credits steps ticked during a session to it, and logs it in the done list', () => {
    const { loom, steps, task } = setup();
    const s = loom.sessions.start({ kind: 'focus', taskId: task.id });
    loom.subtasks.complete(steps[0].id);
    loom.subtasks.complete(steps[1].id);
    loom.subtasks.uncomplete(steps[1].id);
    const e = loom.sessions.end(s.id);
    expect(e.subtasksCompleted.map((x) => x.title)).toEqual(['Open draft and reread section 2.3']);
    loom.subtasks.complete(steps[1].id); // after the session: not credited
    expect(loom.sessions.get(s.id).subtasksCompleted).toHaveLength(1);
    expect(loom.tasks.doneToday().sessions).toEqual([expect.objectContaining({ id: s.id, kind: 'focus', taskTitle: 'Thesis chapter 2', outcome: 'stopped' })]);
  });

  it('closes a forgotten session as abandoned at its planned end', () => {
    const { loom } = setup();
    const s = loom.sessions.start({ kind: 'starter' }, 'user', at(T0));
    expect(loom.sessions.running(plus(60))).not.toBeNull(); // still within grace
    expect(loom.sessions.running(plus(10 + 121))).toBeNull();
    expect(loom.sessions.get(s.id)).toMatchObject({ outcome: 'abandoned', endedAt: plus(10).toISOString() });
    expect(loom.sessions.start({ kind: 'starter' }, 'user', plus(200)).outcome).toBeNull();
  });

  it('validates lengths and steps, and keeps a readable log after the task is deleted', () => {
    const { loom, task, steps } = setup();
    const other = loom.tasks.create({ title: 'Other' });
    expect(() => loom.sessions.start({ kind: 'starter', minutes: 0 })).toThrow(/between 1 and 240/);
    expect(() => loom.sessions.start({ kind: 'starter', taskId: other.id, subtaskId: steps[0].id })).toThrow(/different task/);
    const s = loom.sessions.start({ kind: 'starter', taskId: task.id }, 'claude');
    loom.sessions.end(s.id);
    loom.tasks.remove(task.id);
    expect(loom.sessions.list()[0]).toMatchObject({ taskId: null, taskTitle: 'Thesis chapter 2', createdBy: 'claude' });
    expect(loom.exporter.json().sessions).toHaveLength(1);
  });
});

describe('parking lot', () => {
  it('parks thoughts under a "Parked" heading in the daily note, after any existing text', () => {
    const loom = testLoom();
    const now = new Date(2026, 9, 21, 10, 5);
    loom.notes.appendDaily('Morning thought', { date: '2026-10-21', now });
    loom.sessions.park('check that email', now);
    loom.sessions.park('look up FSRS paper', new Date(2026, 9, 21, 10, 20));
    loom.notes.appendDaily('Later thought', { date: '2026-10-21', now });
    loom.sessions.park('call Sam back', new Date(2026, 9, 21, 11, 0));
    expect(loom.notes.daily('2026-10-21').body).toBe(
      '**10:05** Morning thought\n\n## Parked\n\n- **10:05** check that email\n- **10:20** look up FSRS paper\n- **11:00** call Sam back\n\n**10:05** Later thought',
    );
  });

  it('parks after midnight into the previous day (the day rolls over at 4am)', () => {
    const loom = testLoom();
    const n = loom.sessions.park('idea at 1am', new Date(2026, 9, 22, 1, 0));
    expect(n.title).toBe('2026-10-21');
  });
});
