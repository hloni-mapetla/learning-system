import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';
import { adjacentRepeats, cardKeys, hashSeed, interleave, seededShuffle } from '../src/services/interleave.ts';

const T0 = new Date('2026-03-02T09:00:00Z');
const days = (d: number) => new Date(T0.getTime() + d * 86_400_000);
const LATER = days(400); // every library card is due by then

/** Three sources with tags, two notes each, three review cards per note, all due at T0. */
function library() {
  const loom = testLoom();
  const ids: string[] = [];
  for (const [title, tag] of [['Kahneman', 'psychology'], ['Tetlock', 'forecasting'], ['Darwin', 'biology']]) {
    const src = loom.sources.create({ title, tags: [tag] });
    for (const k of [1, 2]) {
      const note = loom.notes.create({ title: `${title} idea ${k}`, kind: 'concept', sourceId: src.id });
      for (const q of [1, 2, 3]) {
        const [c] = loom.cards.create({ type: 'basic', front: `${title} ${k}.${q}?`, back: 'a', refs: [{ type: 'note', id: note.id }] });
        loom.review.record(c.id, 'good', { now: days(-20) });
        loom.review.record(c.id, 'good', { now: days(-15) });
        ids.push(c.id);
      }
    }
  }
  return { loom, ids };
}

describe('interleave helpers', () => {
  it('shuffles reproducibly per seed', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    expect(seededShuffle(xs, 1)).toEqual(seededShuffle(xs, 1));
    expect(seededShuffle(xs, 1)).not.toEqual(seededShuffle(xs, 2));
    expect([...seededShuffle(xs, 3)].sort((a, b) => a - b)).toEqual(xs);
    expect(hashSeed('2026-03-02:x')).toBe(hashSeed('2026-03-02:x'));
  });

  it('keeps same-note cards apart and puts early cards first', () => {
    const items = ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'].map((id) => ({ id }));
    const keys = new Map(items.map((i) => [i.id, { note: i.id[0] }]));
    for (let seed = 0; seed < 20; seed++) {
      const out = interleave(items, keys, seed, new Set(['c1']));
      expect(adjacentRepeats(out, keys, 'note')).toBe(0);
      expect(out[0].id).toBe('c1');
    }
  });
});

describe('interleaved daily review', () => {
  it('mixes notes, sources and topics; is stable within a day and changes across days', () => {
    const { loom, ids } = library();
    const scheduled = loom.review.due({ now: LATER, order: 'scheduled' });
    const mixed = loom.review.due({ now: LATER });
    expect(mixed).toHaveLength(18);
    expect(mixed.map((c) => c.id).sort()).toEqual(scheduled.map((c) => c.id).sort()); // same selection
    const keys = cardKeys(loom.db, ids);
    expect(adjacentRepeats(mixed, keys, 'note')).toBe(0);
    expect(adjacentRepeats(mixed, keys, 'source')).toBeLessThanOrEqual(1);
    expect(adjacentRepeats(mixed, keys, 'topic')).toBeLessThanOrEqual(1);
    expect(loom.review.due({ now: new Date(LATER.getTime() + 3_600_000) }).map((c) => c.id)).toEqual(mixed.map((c) => c.id));
    expect(loom.review.due({ now: LATER, seed: 'another day' }).map((c) => c.id)).not.toEqual(mixed.map((c) => c.id));
    expect(keys.get(ids[0])).toMatchObject({ topic: 'psychology' });
  });

  it('can be switched off', () => {
    const { loom } = library();
    loom.settings.set({ interleave: false });
    const plain = loom.review.due({ now: LATER, order: 'scheduled' }).map((c) => c.id);
    expect(plain).toHaveLength(18);
    expect(loom.review.due({ now: LATER }).map((c) => c.id)).toEqual(plain);
  });

  it('introduces one new cloze sibling per note per day, without touching the others', () => {
    const loom = testLoom();
    const n = loom.notes.create({ title: 'Cell', body: 'The {{c1::mitochondria}} makes {{c2::ATP}} via {{c3::oxidative phosphorylation}}.' });
    loom.notes.create({ title: 'Other', body: 'DNA is a {{c1::double helix}}.' });
    let due = loom.review.due({ now: T0 });
    expect(due.filter((c) => c.noteId === n.id)).toHaveLength(1);
    expect(due).toHaveLength(2);
    expect(loom.review.counts({ now: T0 }).new).toBe(2);
    loom.review.record(due.find((c) => c.noteId === n.id)!.id, 'good', { now: T0 });
    // Same day: the sibling still waits. Next day: the next sibling comes in.
    expect(loom.review.due({ now: new Date(T0.getTime() + 60_000) }).filter((c) => c.noteId === n.id && c.state === 'new')).toHaveLength(0);
    due = loom.review.due({ now: days(1) });
    expect(due.filter((c) => c.noteId === n.id && c.state === 'new')).toHaveLength(1);
    expect(loom.cards.list({ noteId: n.id }).items.filter((c) => c.state === 'new')).toHaveLength(2); // nothing rescheduled
  });

  it('defers new cards whose note has an unlearned prerequisite', () => {
    const loom = testLoom();
    loom.settings.set({ newCardsPerDay: 1 });
    const adv = loom.notes.create({ title: 'Bayes theorem', body: '{{c1::posterior}} ∝ likelihood × prior' });
    const base = loom.notes.create({ title: 'Conditional probability', body: 'P(A|B) = {{c1::P(A∩B)/P(B)}}' });
    loom.links.create({ from: { type: 'note', id: base.id }, to: { type: 'note', id: adv.id }, rel: 'prerequisite_of' });
    const first = loom.review.due({ now: T0 });
    expect(first.map((c) => c.noteId)).toEqual([base.id]);
    loom.review.record(first[0].id, 'good', { now: T0 });
    loom.settings.set({ newCardsPerDay: 2 });
    expect(loom.review.due({ now: days(1) }).filter((c) => c.state === 'new').map((c) => c.noteId)).toEqual([adv.id]);
  });

  it('records the context of a review', () => {
    const loom = testLoom();
    const [c] = loom.cards.create({ type: 'basic', front: 'Q', back: 'A' });
    loom.review.record(c.id, 'good', { now: T0, context: 'practice' });
    expect(loom.db.get<{ context: string }>('SELECT context FROM review_logs')!.context).toBe('practice');
  });
});

describe('practice sets and confusable pairs', () => {
  it('mixes 2+ topics: due first, then the weakest not-due cards, topics alternating', async () => {
    const { loom } = library();
    // At T0 nothing is due; at LATER everything is.
    const early = await loom.practice.practiceSet({ topics: ['psychology', 'forecasting'], size: 8, now: days(-14) });
    expect(early.cards).toHaveLength(8);
    expect(early.cards.every((c) => !c.isDue)).toBe(true);
    expect(early.topics.map((t) => [t.topic, t.matchedBy, t.available, t.picked])).toEqual([['psychology', 'tag', 6, 4], ['forecasting', 'tag', 6, 4]]);
    const keys = new Map(early.cards.map((c) => [c.id, { topic: c.practiceTopic }]));
    expect(adjacentRepeats(early.cards, keys, 'topic')).toBe(0);
    const later = await loom.practice.practiceSet({ topics: ['psychology', 'biology'], size: 4, now: LATER, includeNotDue: false });
    expect(later.cards.every((c) => c.isDue)).toBe(true);
    await expect(loom.practice.practiceSet({ topics: ['psychology'] })).rejects.toThrow(/two topics/);
  });

  it('finds confusable pairs from contradicts/related links and from similar ideas under different topics', async () => {
    const loom = testLoom();
    const k = loom.sources.create({ title: 'Kahneman', tags: ['psychology'] });
    const t = loom.sources.create({ title: 'Tetlock', tags: ['forecasting'] });
    const anchoring = loom.notes.create({ title: 'Anchoring', kind: 'concept', sourceId: k.id, body: 'Estimates drift toward an initial number, even an arbitrary one.' });
    const baseRate = loom.notes.create({ title: 'Base rates first', kind: 'claim', sourceId: t.id, body: 'Start forecasts from the base rate before adjusting for specifics.' });
    const ease = loom.notes.create({ title: 'Cognitive ease', kind: 'concept', sourceId: k.id, body: 'Fluent repeated statements feel true; familiarity breeds belief.' });
    const fluent = loom.notes.create({ title: 'Fluent stories', kind: 'claim', sourceId: t.id, body: 'Fluent repeated stories feel true and breed overconfident belief.' });
    loom.links.create({ from: { type: 'note', id: anchoring.id }, to: { type: 'note', id: baseRate.id }, rel: 'contradicts', rationale: 'an arbitrary anchor vs a principled one' });
    const pairs = await loom.practice.confusables({ topics: ['psychology', 'forecasting'] });
    expect(pairs[0]).toMatchObject({ reason: 'contradicts', a: { title: 'Anchoring', topic: 'psychology' }, b: { title: 'Base rates first', topic: 'forecasting' } });
    expect(pairs[0].a.text).toMatch(/initial number/);
    const sim = pairs.find((p) => p.reason === 'similar');
    expect(sim && [sim.a.id, sim.b.id].sort()).toEqual([ease.id, fluent.id].sort());
  });
});
