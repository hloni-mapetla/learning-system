import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';
import { recallFragments } from '../src/services/processing.ts';

function bookWithHighlights() {
  const loom = testLoom();
  const s = loom.sources.create({ title: 'Meditations', status: 'done' });
  loom.importer.pasted(
    'The obstacle on the path becomes the path.\n\nWaste no more time arguing about what a good man should be. Be one.\n\nVery little is needed to make a happy life.',
    { sourceId: s.id },
  );
  return { loom, s };
}

describe('recall-first processing', () => {
  it('starts with no recall and counts highlights without revealing them', () => {
    const { loom, s } = bookWithHighlights();
    const st = loom.processing.status(s.id);
    expect(st).toMatchObject({ state: 'none', highlightCount: 3, recalls: [] });
    expect(JSON.stringify(st)).not.toContain('obstacle');
    expect(loom.sourceDetail(s.id).recallState).toBe('none');
  });

  it('saves a recall verbatim as the learner, marks the source recall_first and starts a queued source', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'The Scout Mindset' });
    const n = loom.processing.saveRecall(s.id, '  Soldier vs scout mindset.\nMotivated reasoning protects identity.  ');
    expect(n).toMatchObject({ kind: 'recall', createdBy: 'user', sourceId: s.id, body: 'Soldier vs scout mindset.\nMotivated reasoning protects identity.' });
    expect(n.title).toMatch(/^Recall: The Scout Mindset \(\d{4}-\d{2}-\d{2}\)$/);
    expect(loom.sources.get(s.id)).toMatchObject({ method: 'recall_first', status: 'reading' });
    expect(loom.processing.stateOf(s.id)).toBe('done');
    expect(() => loom.processing.saveRecall(s.id, '   ')).toThrow(/needs some text/);
  });

  it('skipping marks highlights_first, and a later recall keeps that method', () => {
    const { loom, s } = bookWithHighlights();
    expect(loom.processing.skipRecall(s.id).state).toBe('skipped');
    expect(loom.sources.get(s.id).method).toBe('highlights_first');
    loom.processing.saveRecall(s.id, 'Something about obstacles.');
    expect(loom.sources.get(s.id).method).toBe('highlights_first');
    expect(loom.processing.stateOf(s.id)).toBe('done');
  });

  it('compares the recall with highlights: recalled ones score higher than missed ones', async () => {
    const { loom, s } = bookWithHighlights();
    loom.processing.saveRecall(s.id, 'The obstacle on the path becomes the path itself.\nSomething about arguing less.');
    loom.notes.create({ kind: 'concept', title: 'Obstacle is the way', body: 'Mine.', sourceId: s.id });
    loom.notes.create({ kind: 'concept', title: 'Drafted by Claude', body: 'Not mine.', sourceId: s.id }, 'claude');
    const c = await loom.processing.compare(s.id);
    expect(c.recalls).toHaveLength(1);
    const score = (word: string) => c.highlights.find((h) => h.quote.includes(word))!.similarity!;
    expect(score('obstacle')).toBeGreaterThan(score('happy'));
    expect(c.highlights.find((h) => h.quote.includes('obstacle'))!.nearestFragment).toContain('obstacle');
    expect(c.ownNotes.map((n) => n.title)).toEqual(['Obstacle is the way']);
    expect(c.claudeNotes).toBe(1);
  });

  it('works without an embedder (no similarity hint)', async () => {
    const { createLoom } = await import('../src/index.ts');
    const loom = createLoom({ dbPath: ':memory:', embedder: null });
    const s = loom.sources.create({ title: 'B' });
    loom.importer.pasted('A quote worth keeping.', { sourceId: s.id });
    loom.processing.saveRecall(s.id, 'I remember a quote.');
    expect((await loom.processing.compare(s.id)).highlights[0].similarity).toBeNull();
  });

  it('splits recalls into fragments for the hint', () => {
    expect(recallFragments('- First idea here.\n- Second: short\n\n1) Third idea is longer. Fourth sentence too!')).toEqual([
      'First idea here.',
      'Second: short',
      'Third idea is longer.',
      'Fourth sentence too!',
    ]);
  });
});

describe('authorship', () => {
  it('records who wrote notes and sources, and lets the learner correct it', () => {
    const loom = testLoom();
    expect(loom.notes.create({ title: 'Mine' }).createdBy).toBe('user');
    const c = loom.notes.create({ title: 'Claude draft' }, 'claude');
    expect(c.createdBy).toBe('claude');
    expect(loom.notes.update(c.id, { createdBy: 'user' }).createdBy).toBe('user');
    const r = loom.importer.pasted('Imported quote.', { sourceTitle: 'New book' });
    expect(loom.notes.get(r.noteIds[0]).createdBy).toBe('system');
    expect(loom.sources.get(r.sources[0].id).createdBy).toBe('system'); // created by the importer
    expect(loom.sources.create({ title: 'By Claude' }, 'claude').createdBy).toBe('claude');
    const md = loom.importer.markdown('---\ntitle: From my vault\n---\nMy own words.');
    expect(loom.notes.get(md.noteIds[0]).createdBy).toBe('user');
  });
});
