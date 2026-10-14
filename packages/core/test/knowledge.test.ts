import { describe, expect, it } from 'vitest';
import { testLoom } from './helpers.ts';
import { parseWikilinks } from '../src/index.ts';

describe('wikilinks', () => {
  it('parses targets, labels and headings, ignoring code', () => {
    const refs = parseWikilinks('See [[Stoicism]] and [[Marcus Aurelius|the emperor]], [[Stoicism#Ethics]], `[[not a link]]`');
    expect(refs).toEqual([
      { target: 'Stoicism', label: null },
      { target: 'Marcus Aurelius', label: 'the emperor' },
    ]);
  });
});

describe('sources and notes', () => {
  it('creates a source with tags and stamps reading dates on status change', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'Meditations', authors: 'Marcus Aurelius', tags: ['Philosophy/Stoicism'] });
    expect(s.status).toBe('queued');
    expect(s.tags).toEqual(['philosophy/stoicism']);
    const reading = loom.sources.update(s.id, { status: 'reading' });
    expect(reading.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(loom.sources.list({ tag: 'philosophy' }).total).toBe(1);
  });

  it('derives titles and defaults highlights', () => {
    const loom = testLoom();
    const n = loom.notes.create({ quote: 'You have power over your mind — not outside events.', location: 'Book 6' });
    expect(n.kind).toBe('highlight');
    expect(n.title).toBe('You have power over your mind — not outside events.');
    const h = loom.notes.create({ body: '# Dichotomy of control\nSome things are up to us.' });
    expect(h.title).toBe('Dichotomy of control');
  });

  it('resolves wikilinks, backlinks and dangling links', () => {
    const loom = testLoom();
    const a = loom.notes.create({ title: 'Virtue', body: 'Linked to [[Dichotomy of control]] and [[Meditations]].' });
    let d = loom.noteDetail(a.id);
    expect(d.outgoing.map((l) => l.to)).toEqual([null, null]); // both dangling
    const src = loom.sources.create({ title: 'Meditations' });
    const b = loom.notes.create({ title: 'Control', aliases: ['Dichotomy of control'] });
    d = loom.noteDetail(a.id);
    expect(d.outgoing.map((l) => l.to?.id).sort()).toEqual([b.id, src.id].sort());
    expect(loom.noteDetail(b.id).backlinks[0].from.id).toBe(a.id);
    // Editing the body rebuilds wikilinks.
    loom.notes.update(a.id, { body: 'Only [[Control]] now.' });
    expect(loom.noteDetail(a.id).outgoing.map((l) => l.to?.id)).toEqual([b.id]);
    // Deleting the target makes the link dangle again rather than vanish.
    loom.notes.remove(b.id);
    expect(loom.noteDetail(a.id).outgoing[0]).toMatchObject({ to: null, targetTitle: 'Control' });
  });

  it('creates typed links idempotently and rejects bad ones', () => {
    const loom = testLoom();
    const a = loom.notes.create({ title: 'A', kind: 'claim' });
    const b = loom.notes.create({ title: 'B', kind: 'claim' });
    const l1 = loom.links.create({ from: { type: 'note', id: a.id }, to: { type: 'note', id: b.id }, rel: 'contradicts' }, 'claude');
    const l2 = loom.links.create({ from: { type: 'note', id: a.id }, to: { type: 'note', id: b.id }, rel: 'contradicts', rationale: 'why' });
    expect(l2.id).toBe(l1.id);
    expect(l2.rationale).toBe('why');
    expect(l1.createdBy).toBe('claude');
    expect(() => loom.links.create({ from: { type: 'note', id: a.id }, to: { type: 'note', id: a.id }, rel: 'related' })).toThrow();
    expect(() => loom.links.create({ from: { type: 'note', id: a.id }, to: { type: 'note', id: 'nope' }, rel: 'related' })).toThrow(/not found/);
  });

  it('dedupes imports by key', () => {
    const loom = testLoom();
    const a = loom.notes.create({ quote: 'x', dedupeKey: 'k1' });
    const b = loom.notes.create({ quote: 'x', dedupeKey: 'k1' });
    expect(b.id).toBe(a.id);
  });
});

describe('search', () => {
  it('full-text search with stemming, prefix and snippets', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'The Selfish Gene', authors: 'Richard Dawkins' });
    loom.notes.create({ title: 'Replicators', body: 'Genes are replicating molecules that build survival machines.', sourceId: s.id });
    loom.notes.create({ title: 'Unrelated', body: 'Bread recipes.' });
    const hits = loom.search.fullText('replicate');
    expect(hits[0].title).toBe('Replicators');
    expect(hits[0].sourceTitle).toBe('The Selfish Gene');
    expect(loom.search.fullText('dawk')[0]).toMatchObject({ type: 'source', title: 'The Selfish Gene' });
    expect(loom.search.fullText('survival machines')[0].snippet).toContain('**survival**');
    // AND falls back to OR when nothing matches all terms.
    expect(loom.search.fullText('molecules zebra').length).toBe(1);
    expect(loom.search.fullText('"); DROP TABLE notes; --')).toEqual([]);
  });

  it('semantic search finds paraphrases and hybrid merges both', async () => {
    const loom = testLoom();
    const n = loom.notes.create({ title: 'Transport', body: 'The automobile changed cities.' });
    loom.notes.create({ title: 'Cooking', body: 'Bread recipes and baking.' });
    expect(loom.embeddings.pending()).toBe(2);
    const sem = await loom.search.semantic('car');
    expect(sem[0].id).toBe(n.id);
    expect(loom.embeddings.pending()).toBe(0);
    const hy = await loom.search.hybrid('automobile cities');
    expect(hy[0]).toMatchObject({ id: n.id, matchedBy: ['text', 'semantic'] });
  });

  it('re-embeds only changed chunks', async () => {
    const loom = testLoom();
    const n = loom.notes.create({ title: 'T', body: 'one\n\ntwo' });
    await loom.embeddings.drain();
    const v1 = loom.db.get(`SELECT value FROM meta WHERE key='chunks_version'`)!.value;
    loom.notes.update(n.id, { tags: ['x'] }); // re-queued, text unchanged
    await loom.embeddings.drain();
    expect(loom.db.get(`SELECT value FROM meta WHERE key='chunks_version'`)!.value).toBe(v1);
  });
});
