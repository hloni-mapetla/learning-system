import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';
import { localDate, REVIEW_TASK_ID } from '../src/index.ts';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDate(d);
};

describe('tasks', () => {
  it("shows today's tasks with a virtual review task when cards are due", () => {
    const loom = testLoom();
    loom.tasks.create({ title: 'overdue', dueDate: day(-2) });
    loom.tasks.create({ title: 'today', dueDate: day(0), priority: 2 });
    loom.tasks.create({ title: 'tomorrow', dueDate: day(1) });
    loom.tasks.create({ title: 'someday' });
    loom.tasks.create({ title: 'urgent undated', priority: 1 });
    expect(loom.tasks.list({ view: 'today' }).map((t) => t.title)).toEqual(['overdue', 'today', 'urgent undated']);
    loom.cards.create({ type: 'basic', front: 'q', back: 'a' });
    const today = loom.tasks.list({ view: 'today' });
    expect(today[0]).toMatchObject({ id: REVIEW_TASK_ID, title: 'Review 1 due card', virtual: true });
    expect(loom.tasks.list({ view: 'upcoming' }).map((t) => t.title)).toEqual(['tomorrow']);
  });

  it('completing a reading task prompts capture and starts the source', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'Meditations' });
    const t = loom.tasks.create({ title: 'Read book 1', kind: 'read', sourceId: s.id });
    const r = loom.tasks.complete(t.id);
    expect(r.task.status).toBe('done');
    expect(r.task.completedAt).toBeTruthy();
    expect(r.followUp).toMatchObject({ action: 'capture_highlights', sourceId: s.id, sourceTitle: 'Meditations' });
    expect(loom.sources.get(s.id).status).toBe('reading');
    expect(loom.tasks.complete(loom.tasks.create({ title: 'x' }).id).followUp).toBeNull();
    expect(loom.tasks.list({ view: 'done' })).toHaveLength(2);
  });

  it('builds a reading queue by priority with open tasks', () => {
    const loom = testLoom();
    const a = loom.sources.create({ title: 'A', priority: 3 });
    loom.sources.create({ title: 'B', priority: 1 });
    loom.sources.create({ title: 'C', status: 'reading', priority: 5 });
    loom.sources.create({ title: 'D', status: 'done' });
    loom.tasks.create({ title: 'read ch 4', kind: 'read', sourceId: a.id });
    const q = loom.tasks.readingQueue();
    expect(q.map((s) => s.title)).toEqual(['C', 'B', 'A']);
    expect(q[2].openTasks[0].title).toBe('read ch 4');
  });
});

describe('graph', () => {
  it('builds global and local graphs', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'Book' });
    const a = loom.notes.create({ title: 'A', sourceId: s.id, body: '[[B]]' });
    const b = loom.notes.create({ title: 'B' });
    const c = loom.notes.create({ title: 'C' });
    const d = loom.notes.create({ title: 'D', sourceId: s.id });
    loom.links.create({ from: { type: 'note', id: b.id }, to: { type: 'note', id: c.id }, rel: 'contradicts' });
    const g = loom.graph.build();
    expect(g.nodes).toHaveLength(5);
    expect(g.edges.map((e) => e.rel).sort()).toEqual(['contradicts', 'from_source', 'from_source', 'wikilink']);
    const local = loom.graph.build({ focus: c.id, depth: 2 });
    expect(local.nodes.map((n) => n.title).sort()).toEqual(['A', 'B', 'C']);
    // Expanding through a source hub doesn't pull in its other notes beyond depth.
    const fromA = loom.graph.build({ focus: a.id, depth: 2 });
    expect(fromA.nodes.map((n) => n.title).sort()).toEqual(['A', 'B', 'Book', 'C']);
    expect(loom.graph.build({ hideIsolated: true, includeSourceEdges: false }).nodes.map((n) => n.title).sort()).toEqual(['A', 'B', 'C']);
    void d;
  });
});
