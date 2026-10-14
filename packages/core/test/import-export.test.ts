import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testLoom } from './helpers.ts';
import { parseKindleClippings } from '../src/index.ts';
import { parseFrontmatter, splitPastedHighlights } from '../src/importers/markdown.ts';
import { createLoom } from '../src/index.ts';

const CLIPPINGS = `﻿Thinking, Fast and Slow (Kahneman, Daniel)
- Your Highlight on page 62 | Location 940-941 | Added on Monday, 3 March 2025 21:14:05

A reliable way to make people believe in falsehoods is frequent repetition
==========
Thinking, Fast and Slow (Kahneman, Daniel)
- Your Highlight on page 62 | Location 940-942 | Added on Monday, 3 March 2025 21:14:30

A reliable way to make people believe in falsehoods is frequent repetition, because familiarity is not easily distinguished from truth.
==========
Thinking, Fast and Slow (Kahneman, Daniel)
- Your Note on page 62 | Location 942 | Added on Monday, 3 March 2025 21:15:02

cognitive ease!
==========
Thinking, Fast and Slow (Kahneman, Daniel)
- Your Bookmark on page 70 | Location 1050 | Added on Monday, 3 March 2025 21:30:00


==========
Meditations (Marcus Aurelius)
- Your Highlight at location 120-122 | Added on Tuesday, 4 March 2025 08:00:00

You have power over your mind - not outside events.
==========
`;

describe('Kindle import', () => {
  it('parses clippings, keeps the longest overlapping highlight, skips bookmarks', () => {
    const c = parseKindleClippings(CLIPPINGS);
    expect(c.map((x) => x.kind)).toEqual(['highlight', 'note', 'highlight']);
    expect(c[0]).toMatchObject({ bookTitle: 'Thinking, Fast and Slow', author: 'Daniel Kahneman', page: '62', location: '940-942' });
    expect(c[0].text).toContain('because familiarity');
    expect(c[2]).toMatchObject({ bookTitle: 'Meditations', author: 'Marcus Aurelius', page: null, location: '120-122' });
  });

  it('creates sources and highlight notes, attaches Kindle notes, and is idempotent', () => {
    const loom = testLoom();
    const r = loom.importer.kindle(CLIPPINGS);
    expect(r.created).toBe(2);
    expect(r.sources.map((s) => [s.title, s.created, s.highlights])).toEqual([
      ['Thinking, Fast and Slow', true, 1],
      ['Meditations', true, 1],
    ]);
    const tfs = loom.sourceDetail(r.sources[0].id);
    expect(tfs.authors).toBe('Daniel Kahneman');
    expect(tfs.notes[0]).toMatchObject({ kind: 'highlight', location: 'p. 62, loc 940-942', body: 'cognitive ease!' });
    expect(loom.importer.kindle(CLIPPINGS)).toMatchObject({ created: 0, skipped: 2 });
  });
});

describe('Markdown & paste import', () => {
  it('parses frontmatter and imports into an existing or new source', () => {
    const md = `---\ntitle: Dual process theory\nkind: concept\nsource: "[[Thinking, Fast and Slow]]"\nauthor: Daniel Kahneman\ntags: [psychology, "cognition"]\naliases:\n  - System 1 and System 2\n---\n# Ignored heading\n\nSystem 1 is fast; see [[Cognitive ease]].`;
    const p = parseFrontmatter(md);
    expect(p).toMatchObject({ title: 'Dual process theory', meta: { tags: ['psychology', 'cognition'], aliases: ['System 1 and System 2'] } });
    const loom = testLoom();
    const r = loom.importer.markdown(md);
    const n = loom.noteDetail(r.noteIds[0]);
    expect(n).toMatchObject({ kind: 'concept', title: 'Dual process theory', sourceTitle: 'Thinking, Fast and Slow', tags: ['cognition', 'psychology'] });
    expect(n.outgoing[0].targetTitle).toBe('Cognitive ease');
    expect(loom.importer.markdown(md).skipped).toBe(1);
    // Title falls back to H1, then filename.
    expect(parseFrontmatter('# Hello\n\nbody').title).toBe('Hello');
    expect(loom.notes.get(loom.importer.markdown('just text', { filename: 'My idea.md' }).noteIds[0]).title).toBe('My idea');
  });

  it('splits pasted highlights with locations and notes', () => {
    const h = splitPastedHighlights(`"The map is not the territory." (p. 12)\n\nNote: Korzybski\n\n- Second quote — loc 340\n\nThird, no location`);
    expect(h).toEqual([
      { quote: 'The map is not the territory.', location: 'p. 12', note: 'Korzybski' },
      { quote: 'Second quote', location: 'loc 340', note: null },
      { quote: 'Third, no location', location: null, note: null },
    ]);
    const loom = testLoom();
    const r = loom.importer.pasted('A\n\nB (p. 3)', { sourceTitle: 'Some Book', authors: 'X' });
    expect(r).toMatchObject({ created: 2, sources: [{ title: 'Some Book', created: true, highlights: 2 }] });
  });
});

describe('stats', () => {
  it('computes retention, mastery by topic and source, streak and forecast', () => {
    const loom = testLoom();
    const s = loom.sources.create({ title: 'Bio', tags: ['biology'] });
    const n = loom.notes.create({ title: 'Cell', sourceId: s.id, body: '{{c1::Mitochondria}} make ATP; {{c2::ribosomes}} make protein.' });
    const [c1, c2] = loom.cards.list({ noteId: n.id }).items;
    const now = new Date();
    const t0 = new Date(now.getTime() - 3 * 86400_000);
    loom.review.record(c1.id, 'easy', { now: t0 });
    loom.review.record(c1.id, 'good', { now: new Date(loom.cards.get(c1.id).due) < now ? new Date(loom.cards.get(c1.id).due) : now });
    loom.review.record(c2.id, 'again', { now });
    const st = loom.stats.compute(now);
    expect(st.totals.cards).toMatchObject({ review: 1, learning: 1 }); // again on a new card → learning
    expect(st.retention[0]).toMatchObject({ days: 7, reviews: 1, rate: 1 });
    expect(st.reviewedToday).toBeGreaterThanOrEqual(1);
    expect(st.streak).toBeGreaterThanOrEqual(1);
    expect(st.topics[0]).toMatchObject({ name: 'biology', cards: 2, reviewed: 2 });
    expect(st.sources[0]).toMatchObject({ name: 'Bio', cards: 2 });
    expect(st.sources[0].mastery).toBeGreaterThan(0);
    expect(st.forecast).toHaveLength(30);
    expect(st.daily).toHaveLength(30);
  });
});

describe('export & backup', () => {
  it('exports JSON without secrets, a Markdown vault, and snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-'));
    const loom = createLoom({ dbPath: join(dir, 'loom.db'), embedder: null });
    loom.settings.setRaw('owner_password', { salt: 'x', hash: 'y' });
    const s = loom.sources.create({ title: 'Meditations', authors: 'Marcus Aurelius', tags: ['stoicism'] });
    const a = loom.notes.create({ title: 'Control', sourceId: s.id, quote: 'You have power over your mind', body: 'See [[Virtue]]' });
    const b = loom.notes.create({ title: 'Virtue', body: 'The only good.' });
    loom.links.create({ from: { type: 'note', id: a.id }, to: { type: 'note', id: b.id }, rel: 'supports', rationale: 'why' });
    loom.cards.create({ type: 'basic', front: 'Q?', back: 'A', refs: [{ type: 'note', id: a.id }] });

    const j = loom.exporter.json() as any;
    expect(j.notes).toHaveLength(2);
    expect(JSON.stringify(j)).not.toContain('owner_password');

    const vault = join(dir, 'vault');
    loom.exporter.markdownVault(vault);
    expect(readdirSync(vault).sort()).toEqual(['Meditations', '_notes']);
    const control = readFileSync(join(vault, 'Meditations', 'Control.md'), 'utf8');
    expect(control).toContain('source: "[[Meditations]]"');
    expect(control).toContain('> You have power over your mind');
    expect(control).toContain('- supports [[Virtue]] — why');
    expect(readFileSync(join(vault, 'Meditations', '_cards.md'), 'utf8')).toContain('**Q:** Q?');

    const p = loom.exporter.backup(join(dir, 'backups'), 2);
    expect(existsSync(p)).toBe(true);
    const copy = createLoom({ dbPath: p, embedder: null });
    expect(copy.notes.list().total).toBe(2);
    copy.close();
    loom.close();
  });
});
