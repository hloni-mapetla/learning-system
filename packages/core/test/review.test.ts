import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';
import { clozeIndices, clozePrompt, clozeAnswer, clozeContext } from '../src/services/cloze.ts';

const T0 = new Date('2026-03-02T09:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const days = (d: number) => at(d * 24 * 60);

function basic(loom: ReturnType<typeof testLoom>, front = 'Q?', back = 'A') {
  return loom.cards.create({ type: 'basic', front, back })[0];
}

describe('cloze parsing', () => {
  const text = 'The {{c1::mitochondria}} is the {{c2::powerhouse::metaphor}} of the cell.\n\nUnrelated para.\n\nMore {{c1::mito}}.';
  it('finds indices, prompts and answers', () => {
    expect(clozeIndices(text)).toEqual([1, 2]);
    expect(clozePrompt('The {{c1::mitochondria}} is the {{c2::powerhouse::metaphor}}', 2)).toBe('The mitochondria is the [metaphor]');
    expect(clozeAnswer('The {{c1::mitochondria}} is', 1)).toBe('The **mitochondria** is');
    expect(clozeContext(text, 2)).toBe('The {{c1::mitochondria}} is the {{c2::powerhouse::metaphor}} of the cell.');
    expect(clozeContext(text, 1).split('\n\n')).toHaveLength(2);
  });
});

describe('cards', () => {
  it('requires answers, valid refs, and 2+ sources for synthesis', () => {
    const loom = testLoom();
    expect(() => loom.cards.create({ type: 'basic', front: 'Q' })).toThrow(/back/);
    expect(() => loom.cards.create({ type: 'cloze', front: 'no deletions' })).toThrow(/cloze/);
    const a = loom.sources.create({ title: 'A' });
    const b = loom.sources.create({ title: 'B' });
    const na = loom.notes.create({ title: 'claim a', sourceId: a.id });
    const na2 = loom.notes.create({ title: 'claim a2', sourceId: a.id });
    const nb = loom.notes.create({ title: 'claim b', sourceId: b.id });
    expect(() =>
      loom.cards.create({ type: 'synthesis', front: 'Compare', refs: [{ type: 'note', id: na.id }, { type: 'note', id: na2.id }] }),
    ).toThrow(/two different sources/);
    const [syn] = loom.cards.create(
      { type: 'synthesis', front: 'How does a bear on b?', rubric: 'Mentions X', refs: [{ type: 'note', id: na.id }, { type: 'note', id: nb.id }] },
      'claude',
    );
    expect(syn.refs.map((r) => r.sourceTitle)).toEqual(['A', 'B']);
    expect(syn.createdBy).toBe('claude');
    expect(loom.cards.countForItem('source', a.id)).toBe(1);
    expect(() => loom.cards.create({ type: 'open', front: 'x', refs: [{ type: 'note', id: 'missing' }] })).toThrow(/not found/);
  });

  it('creates one card per manual cloze deletion', () => {
    const loom = testLoom();
    const cs = loom.cards.create({ type: 'cloze', front: '{{c1::Paris}} is the capital of {{c2::France}}' });
    expect(cs.map((c) => c.prompt)).toEqual(['[...] is the capital of France', 'Paris is the capital of [...]']);
    expect(cs[1].hidden).toEqual(['France']);
  });

  it('syncs cloze cards from note bodies, preserving scheduling across edits', () => {
    const loom = testLoom();
    const n = loom.notes.create({ title: 'Cell', body: 'The {{c1::mitochondria}} makes ATP.\n\n{{c2::Ribosomes}} make proteins.' });
    let cs = loom.cards.list({ noteId: n.id }).items;
    expect(cs).toHaveLength(2);
    const c1 = cs.find((c) => c.clozeIndex === 1)!;
    expect(c1.prompt).toBe('The [...] makes ATP.');
    loom.review.record(c1.id, 'good', { now: T0 });
    loom.notes.update(n.id, { body: 'The {{c1::mitochondrion}} makes ATP via respiration.' });
    cs = loom.cards.list({ noteId: n.id }).items;
    expect(cs).toHaveLength(1); // c2 removed
    expect(cs[0].id).toBe(c1.id); // same card, history kept
    expect(cs[0].reps).toBe(1);
    expect(cs[0].prompt).toBe('The [...] makes ATP via respiration.');
    expect(() => loom.cards.update(c1.id, { front: 'x' })).toThrow(/edit the note/);
    loom.notes.remove(n.id);
    expect(loom.cards.list().total).toBe(0);
  });
});

describe('FSRS scheduling', () => {
  it('moves new → learning → review with growing intervals', () => {
    const loom = testLoom();
    const c = basic(loom);
    expect(c.state).toBe('new');
    let r = loom.review.record(c.id, 'good', { now: T0 });
    expect(r.card.state).toBe('learning');
    expect(r.nextIn).toBe('10 min');
    r = loom.review.record(c.id, 'good', { now: at(10) });
    expect(r.card.state).toBe('review');
    const firstInterval = new Date(r.card.due).getTime() - at(10).getTime();
    expect(firstInterval).toBeGreaterThanOrEqual(24 * 3600_000);
    r = loom.review.record(c.id, 'good', { now: new Date(r.card.due) });
    const second = new Date(r.card.due).getTime() - new Date(r.card.lastReview!).getTime();
    expect(second).toBeGreaterThan(firstInterval);
    expect(r.card.reps).toBe(3);
  });

  it('easy on a new card graduates straight to review', () => {
    const loom = testLoom();
    const r = loom.review.record(basic(loom).id, 'easy', { now: T0 });
    expect(r.card.state).toBe('review');
  });

  it('lapses go to relearning and count lapses', () => {
    const loom = testLoom();
    const c = basic(loom);
    loom.review.record(c.id, 'easy', { now: T0 });
    const due = new Date(loom.cards.get(c.id).due);
    const r = loom.review.record(c.id, 'again', { now: due });
    expect(r.card.state).toBe('relearning');
    expect(r.card.lapses).toBe(1);
    expect(r.nextIn).toBe('10 min');
  });

  it('accepts numeric ratings and rejects bad ones', () => {
    const loom = testLoom();
    const c = basic(loom);
    expect(loom.review.record(c.id, 3, { now: T0 }).rating).toBe('good');
    expect(() => loom.review.record(c.id, 7 as any)).toThrow();
  });

  it('previews intervals for every rating, ordered', () => {
    const loom = testLoom();
    const c = basic(loom);
    loom.review.record(c.id, 'easy', { now: T0 });
    const p = loom.review.preview(c.id, days(20));
    expect(Object.keys(p)).toEqual(['again', 'hard', 'good', 'easy']);
    expect(p.again).toBe('10 min');
  });

  it('undo restores the previous scheduling exactly', () => {
    const loom = testLoom();
    const c = basic(loom);
    loom.review.record(c.id, 'good', { now: T0 });
    const before = loom.cards.get(c.id);
    loom.review.record(c.id, 'again', { now: at(10), grader: 'claude', notes: 'confused X with Y' });
    expect(loom.review.history(c.id)[0]).toMatchObject({ grader: 'claude', notes: 'confused X with Y' });
    const restored = loom.review.undo();
    expect(restored).toMatchObject({ due: before.due, state: before.state, reps: before.reps, stability: before.stability });
    expect(loom.review.history(c.id)).toHaveLength(1);
  });

  it('orders due cards: learning, then overdue reviews, then new within quota', () => {
    const loom = testLoom();
    loom.settings.set({ newCardsPerDay: 3 }); // the learning card below uses one slot today
    const rev = basic(loom, 'review');
    loom.review.record(rev.id, 'easy', { now: days(-30) }); // long overdue by T0
    const learn = basic(loom, 'learning');
    loom.review.record(learn.id, 'again', { now: at(-5) }); // learning, due ~now
    const n1 = basic(loom, 'new1');
    basic(loom, 'new2');
    basic(loom, 'new3');
    const due = loom.review.due({ now: T0, order: 'scheduled' });
    expect(due.map((c) => c.front)).toEqual(['learning', 'review', 'new1', 'new2']);
    // Interleaving reorders the same selection.
    expect(loom.review.due({ now: T0 }).map((c) => c.front).sort()).toEqual(['learning', 'new1', 'new2', 'review']);
    // Introducing a new card today uses up quota.
    loom.review.record(n1.id, 'good', { now: T0 });
    expect(loom.review.due({ now: at(1) }).filter((c) => c.state === 'new')).toHaveLength(1);
    expect(loom.review.counts({ now: at(1) })).toMatchObject({ new: 1 });
    // Suspended cards never show up.
    loom.cards.update(rev.id, { suspended: true });
    expect(loom.review.due({ now: at(1) }).map((c) => c.front)).not.toContain('review');
  });

  it('filters due cards by topic via tags on the card, its note, or its source', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'Book', tags: ['history/south-africa'] });
    const n = loom.notes.create({ title: 'N', sourceId: s.id });
    loom.cards.create({ type: 'basic', front: 'via source', back: 'x', refs: [{ type: 'note', id: n.id }] });
    loom.cards.create({ type: 'basic', front: 'via own tag', back: 'x', tags: ['history'] });
    loom.cards.create({ type: 'basic', front: 'other', back: 'x', tags: ['biology'] });
    expect(loom.review.due({ tag: 'history', now: T0 }).map((c) => c.front).sort()).toEqual(['via own tag', 'via source']);
  });

  it('resolves free-text topics through search when no tag matches', async () => {
    const loom = testLoom();
    const n = loom.notes.create({ title: 'Automobiles', body: 'The automobile reshaped cities.' });
    loom.cards.create({ type: 'basic', front: 'Effect on cities?', back: 'Sprawl', refs: [{ type: 'note', id: n.id }] });
    loom.cards.create({ type: 'basic', front: 'Unrelated', back: 'x' });
    const m = await loom.topics.resolve('car');
    expect(m.matchedBy).toBe('search');
    expect(loom.review.due({ cardIds: m.cardIds, now: T0 }).map((c) => c.front)).toEqual(['Effect on cities?']);
  });

  it('forecasts due reviews per day', () => {
    const loom = testLoom();
    const c = basic(loom);
    loom.review.record(c.id, 'easy', { now: T0 });
    const f = loom.review.forecast(30, T0);
    expect(f).toHaveLength(30);
    expect(f.reduce((a, d) => a + d.count, 0)).toBe(1);
  });
});
