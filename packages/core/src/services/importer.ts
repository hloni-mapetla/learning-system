import type { Ctx } from './context.ts';
import type { Sources } from './sources.ts';
import type { Notes } from './notes.ts';
import { parseKindleClippings } from '../importers/kindle.ts';
import { parseFrontmatter, splitPastedHighlights } from '../importers/markdown.ts';
import { sha1 } from '../util.ts';
import type { NoteKind, SourceKind } from '../types.ts';
import { NOTE_KINDS, SOURCE_KINDS } from '../types.ts';

export interface ImportReport {
  sources: { id: string; title: string; created: boolean; highlights: number }[];
  created: number;
  skipped: number;
  noteIds: string[];
}

export function createImporter(ctx: Ctx, sources: Sources, notes: Notes) {
  const { db } = ctx;

  function sourceFor(title: string, authors: string, kind: SourceKind = 'book'): { id: string; title: string; created: boolean } {
    const existing = sources.findByTitle(title);
    if (existing) return { id: existing.id, title: existing.title, created: false };
    const s = sources.create({ title, authors, kind, status: 'reading' }, 'system');
    return { id: s.id, title: s.title, created: true };
  }

  /** Import Kindle "My Clippings.txt". Re-importing the same file is a no-op (deduped per clipping). */
  function kindle(text: string, opts: { onlyBooks?: string[] } = {}): ImportReport {
    const clips = parseKindleClippings(text).filter(
      (c) => c.kind !== 'bookmark' && (!opts.onlyBooks || opts.onlyBooks.some((b) => c.bookTitle.toLowerCase().includes(b.toLowerCase()))),
    );
    const report: ImportReport = { sources: [], created: 0, skipped: 0, noteIds: [] };
    db.tx(() => {
      const byBook = new Map<string, typeof clips>();
      for (const c of clips) byBook.set(c.bookTitle, [...(byBook.get(c.bookTitle) ?? []), c]);
      for (const [title, list] of byBook) {
        const src = sourceFor(title, list[0].author);
        let n = 0;
        // Kindle notes are attached to the highlight at the same location when one exists.
        const notesAt = new Map(list.filter((c) => c.kind === 'note').map((c) => [c.location, c.text]));
        for (const c of list) {
          if (c.kind === 'note' && list.some((h) => h.kind === 'highlight' && h.location && h.location.split('-').includes(c.location ?? ''))) continue;
          const loc = [c.page && `p. ${c.page}`, c.location && `loc ${c.location}`].filter(Boolean).join(', ') || null;
          const key = `kindle:${sha1(`${title}|${c.kind}|${c.text}`)}`;
          const before = db.get('SELECT id FROM notes WHERE dedupe_key = ?', [key]);
          if (before) {
            report.skipped++;
            continue;
          }
          const endLoc = c.location?.split('-').pop() ?? null;
          const comment = c.kind === 'highlight' ? (notesAt.get(endLoc) ?? notesAt.get(c.location) ?? '') : '';
          const note = notes.create(
            c.kind === 'highlight'
              ? { kind: 'highlight', quote: c.text, body: comment, location: loc, sourceId: src.id, dedupeKey: key }
              : { kind: 'note', body: c.text, location: loc, sourceId: src.id, dedupeKey: key },
            'system',
          );
          report.noteIds.push(note.id);
          report.created++;
          n++;
        }
        report.sources.push({ ...src, highlights: n });
      }
    });
    return report;
  }

  /** Import one Markdown file as a note. Frontmatter: title, kind, source, author(s), tags, aliases, location. */
  function markdown(md: string, opts: { filename?: string; sourceId?: string } = {}): ImportReport {
    const p = parseFrontmatter(md);
    const title = p.title ?? opts.filename?.replace(/\.md$/i, '') ?? undefined;
    const str = (k: string) => (typeof p.meta[k] === 'string' ? (p.meta[k] as string) : undefined);
    const arr = (k: string) => (Array.isArray(p.meta[k]) ? (p.meta[k] as string[]) : str(k) ? str(k)!.split(',').map((s) => s.trim()) : undefined);
    const report: ImportReport = { sources: [], created: 0, skipped: 0, noteIds: [] };
    db.tx(() => {
      let sourceId = opts.sourceId;
      const srcTitle = str('source');
      if (!sourceId && srcTitle) {
        const kind = SOURCE_KINDS.includes(str('source_kind') as SourceKind) ? (str('source_kind') as SourceKind) : 'book';
        const s = sourceFor(srcTitle.replace(/^\[\[|\]\]$/g, ''), str('author') ?? str('authors') ?? '', kind);
        report.sources.push({ ...s, highlights: 0 });
        sourceId = s.id;
      }
      const kind = NOTE_KINDS.includes(str('kind') as NoteKind) ? (str('kind') as NoteKind) : undefined;
      const key = `md:${sha1(`${title}|${p.body}`)}`;
      if (db.get('SELECT 1 FROM notes WHERE dedupe_key = ?', [key])) {
        report.skipped++;
        return;
      }
      const n = notes.create({
        title,
        body: p.body,
        kind,
        sourceId,
        tags: arr('tags')?.map((t) => t.replace(/^#/, '')),
        aliases: arr('aliases'),
        location: str('location'),
        dedupeKey: key,
      }); // Markdown files are the learner's own writing
      report.created++;
      report.noteIds.push(n.id);
    });
    return report;
  }

  /** Pasted highlights (blank-line separated) into a source, creating it if needed. */
  function pasted(text: string, opts: { sourceId?: string; sourceTitle?: string; authors?: string }): ImportReport {
    const report: ImportReport = { sources: [], created: 0, skipped: 0, noteIds: [] };
    db.tx(() => {
      const src = opts.sourceId
        ? { id: opts.sourceId, title: sources.get(opts.sourceId).title, created: false }
        : opts.sourceTitle
          ? sourceFor(opts.sourceTitle, opts.authors ?? '')
          : null;
      let n = 0;
      for (const h of splitPastedHighlights(text)) {
        const key = `paste:${sha1(`${src?.id ?? ''}|${h.quote}`)}`;
        if (db.get('SELECT 1 FROM notes WHERE dedupe_key = ?', [key])) {
          report.skipped++;
          continue;
        }
        const note = notes.create({ kind: 'highlight', quote: h.quote, body: h.note ?? '', location: h.location, sourceId: src?.id, dedupeKey: key }, 'system');
        report.noteIds.push(note.id);
        report.created++;
        n++;
      }
      if (src) report.sources.push({ ...src, highlights: n });
    });
    return report;
  }

  return { kindle, markdown, pasted };
}
export type Importer = ReturnType<typeof createImporter>;
