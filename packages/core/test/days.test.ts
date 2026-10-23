import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testLoom } from './helpers.ts';
import { atLocalTime, resolveDay } from '../src/util.ts';
import { DEFAULT_MORNING_ROUTINE } from '../src/types.ts';

// Local times, so the 4am rollover is exercised whatever the machine's timezone.
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const EVENING = local(21, 21, 30); // Wed 21 Oct, 21:30

function setup() {
  const loom = testLoom();
  const thesis = loom.tasks.create({ title: 'Thesis chapter 2', kind: 'write' });
  const email = loom.tasks.create({ title: 'Email the supervisor', singleStep: true });
  return { loom, thesis, email };
}

describe('dates', () => {
  it('resolves today/tomorrow by the 4am rollover, and times after midnight belong to the next morning', () => {
    expect(resolveDay('today', local(22, 1))).toBe('2026-10-21');
    expect(resolveDay('tomorrow', local(22, 1))).toBe('2026-10-22');
    expect(resolveDay('tomorrow', local(22, 9))).toBe('2026-10-23');
    expect(atLocalTime('2026-10-21', '07:15').getTime()).toBe(local(21, 7, 15).getTime());
    expect(atLocalTime('2026-10-21', '01:30').getTime()).toBe(local(22, 1, 30).getTime());
    expect(() => atLocalTime('2026-10-21', '7am')).toThrow(/like 07:30/);
    expect(() => resolveDay('next week')).toThrow();
  });
});

describe('evening plan', () => {
  it('a task with no steps needs a first step written now; it goes in as the next action', () => {
    const { loom, thesis } = setup();
    expect(() => loom.days.plan('tomorrow', { taskId: thesis.id }, 'user', EVENING)).toThrow(/first physical step/);
    const { day, hint } = loom.days.plan('tomorrow', { taskId: thesis.id, stepTitle: 'Open draft.docx and reread 2.3', targetStart: '8:30' }, 'user', EVENING);
    expect(day).toMatchObject({ date: '2026-10-22', targetStart: '08:30', plannedBy: 'user' });
    expect(day.firstThing!.task.id).toBe(thesis.id);
    expect(day.firstThing!.step!.title).toBe('Open draft.docx and reread 2.3');
    expect(day.firstThing!.task.nextAction!.id).toBe(day.firstThing!.step!.id);
    expect(hint).toBeNull();
    // Writing the first step counts as progress today.
    expect(loom.tasks.doneToday().stepsDefined).toHaveLength(1); // logged at the real time
  });

  it('a new step goes before the current next action, not after done steps; vague steps get the soft hint', () => {
    const { loom, thesis } = setup();
    const { added } = loom.subtasks.add(thesis.id, ['Outline section 2.3', 'Write the intro paragraph']);
    loom.subtasks.complete(added[0].id);
    const { day, hint } = loom.days.plan('tomorrow', { taskId: thesis.id, stepTitle: 'work on it' }, 'user', EVENING);
    expect(day.firstThing!.task.subtasks.map((s) => s.title)).toEqual(['Outline section 2.3', 'work on it', 'Write the intro paragraph']);
    expect(day.firstThing!.step!.title).toBe('work on it');
    expect(hint).toMatch(/physical action/);
  });

  it('defaults to the next action, accepts an open step, and single-step tasks need none', () => {
    const { loom, thesis, email } = setup();
    const { added } = loom.subtasks.add(thesis.id, ['Outline section 2.3', 'Write the intro paragraph']);
    expect(loom.days.plan(undefined, { taskId: thesis.id }, 'user', EVENING).day.firstThing!.step!.id).toBe(added[0].id);
    expect(loom.days.plan(undefined, { taskId: thesis.id, subtaskId: added[1].id }, 'claude', EVENING).day).toMatchObject({ plannedBy: 'claude' });
    expect(loom.days.get('tomorrow', EVENING).firstThing!.step!.id).toBe(added[1].id);
    loom.subtasks.complete(added[0].id);
    expect(() => loom.days.plan(undefined, { taskId: thesis.id, subtaskId: added[0].id }, 'user', EVENING)).toThrow(/already done/);
    const single = loom.days.plan(undefined, { taskId: email.id }, 'user', EVENING).day;
    expect(single.firstThing).toMatchObject({ task: { id: email.id }, step: null });
    expect(() => loom.days.plan(undefined, { taskId: 'review-today' }, 'user', EVENING)).toThrow();
  });

  it('when the planned step gets done, the first thing moves on to the next action; clearing the plan removes it', () => {
    const { loom, thesis } = setup();
    const { added } = loom.subtasks.add(thesis.id, ['Outline section 2.3', 'Write the intro paragraph']);
    loom.days.plan(undefined, { taskId: thesis.id, targetStart: '09:00' }, 'user', EVENING);
    loom.subtasks.complete(added[0].id);
    expect(loom.days.get('tomorrow', EVENING).firstThing!.step!.id).toBe(added[1].id);
    expect(loom.days.clearPlan(undefined, EVENING)).toMatchObject({ firstThing: null, targetStart: null, plannedAt: null });
  });

  it('the shutdown step notes where things were left in the daily note and closes the day', () => {
    const { loom } = setup();
    const d = loom.days.shutdown(undefined, { note: 'Stopped mid-way through 2.3, next: the Smith quote' }, EVENING);
    expect(d).toMatchObject({ date: '2026-10-21', shutdownAt: EVENING.toISOString() });
    expect(loom.notes.daily('2026-10-21').body).toMatch(/## Shutdown\n\n- \*\*21:30\*\* Stopped mid-way/);
    expect(loom.days.shutdown(undefined, { undo: true }, EVENING).shutdownAt).toBeNull();
  });
});

describe('morning', () => {
  const MORNING = local(22, 7, 40);

  it('seeds the default routine once; it can be edited, reordered and trimmed', () => {
    const { loom } = setup();
    const r = loom.days.routine();
    expect(r.map((i) => i.title)).toEqual(DEFAULT_MORNING_ROUTINE.map((i) => i.title));
    expect(r.find((i) => i.title === 'Exercise')!.optional).toBe(true);
    const tea = loom.days.addItem('Make tea', { position: 1 });
    expect(loom.days.routine()[1].id).toBe(tea.id);
    expect(loom.days.updateItem(tea.id, { title: 'Make green tea', optional: true })).toMatchObject({ title: 'Make green tea', optional: true });
    expect(loom.days.moveItem(tea.id, -5)[0].id).toBe(tea.id);
    for (const i of loom.days.routine()) loom.days.removeItem(i.id);
    expect(loom.days.routine()).toEqual([]); // not re-seeded
  });

  it('logging the wake time ticks "Stand up"; ticking "Stand up" logs the wake time; both are editable', () => {
    const { loom } = setup();
    const standUp = loom.days.routine().find((i) => i.action === 'wake')!;
    const a = loom.days.check('today', standUp.id, true, MORNING);
    expect(a.wakeAt).toBe(MORNING.toISOString());
    expect(a.routine.find((i) => i.id === standUp.id)!.checkedAt).toBe(MORNING.toISOString());
    const b = loom.days.logWake('today', '07:05', MORNING);
    expect(b.wakeAt).toBe(local(22, 7, 5).toISOString());
    const c = loom.days.logWake('today', null, MORNING);
    expect(c.wakeAt).toBeNull();
    expect(c.routine.find((i) => i.id === standUp.id)!.checkedAt).toBeNull();
  });

  it('the first session of the day records the work start and ticks "Start first task"', () => {
    const { loom, thesis } = setup();
    loom.days.logWake('today', '07:00', MORNING);
    const s1 = loom.sessions.start({ kind: 'starter', taskId: thesis.id }, 'user', MORNING);
    const day = loom.days.get('today', MORNING);
    expect(day).toMatchObject({ workStartAt: MORNING.toISOString(), workStartSessionId: s1.id, wakeToWorkMinutes: 40 });
    expect(day.routine.find((i) => i.action === 'start_first_task')!.checkedAt).toBe(MORNING.toISOString());

    loom.sessions.end(s1.id, { now: local(22, 7, 45) });
    const s2 = loom.sessions.start({ kind: 'focus', taskId: thesis.id }, 'user', local(22, 8));
    expect(loom.days.get('today', MORNING).workStartSessionId).toBe(s1.id); // only the first counts

    loom.sessions.end(s2.id, { outcome: 'abandoned', now: local(22, 8, 5) });
    expect(loom.days.get('today', MORNING).workStartSessionId).toBe(s1.id); // discarding a later one changes nothing
  });

  it('discarding the only session of the day clears the work start and the routine tick', () => {
    const { loom } = setup();
    const s = loom.sessions.start({ kind: 'starter' }, 'user', MORNING);
    loom.sessions.end(s.id, { outcome: 'abandoned', now: local(22, 7, 41) });
    const day = loom.days.get('today', MORNING);
    expect(day.workStartAt).toBeNull();
    expect(day.routine.find((i) => i.action === 'start_first_task')!.checkedAt).toBeNull();
  });

  it('a session after midnight counts for the evening it belongs to; work start can be typed in', () => {
    const { loom } = setup();
    loom.sessions.start({ kind: 'starter' }, 'user', local(22, 1, 15));
    expect(loom.days.get('2026-10-21').workStartAt).toBe(local(22, 1, 15).toISOString());
    expect(loom.days.setWorkStart('today', '08:10', MORNING)).toMatchObject({ workStartAt: local(22, 8, 10).toISOString(), workStartSessionId: null });
  });

  it('exports days and the routine', () => {
    const { loom, thesis } = setup();
    loom.days.plan(undefined, { taskId: thesis.id, stepTitle: 'Open draft.docx and reread 2.3' }, 'user', EVENING);
    const j = loom.exporter.json() as any;
    expect(j.days).toHaveLength(1);
    expect(j.routine_items.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'loom-days-'));
    loom.exporter.markdownVault(dir);
    const md = readFileSync(join(dir, '_days.md'), 'utf8');
    expect(md).toMatch(/\| \[\[2026-10-22\]\] \|.*Thesis chapter 2 \| Open draft\.docx and reread 2\.3 \|/);
    expect(md).toMatch(/## Morning routine\n\n- Stand up/);
  });
});
