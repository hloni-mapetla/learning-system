import type { Ctx } from './context.ts';
import type { Note, NoteKind } from '../types.ts';
import type { NoteCreate, NotePatch } from '../schemas.ts';
import type { Tags } from './tags.ts';
import type { Links } from './links.ts';
import { newId, nowIso, NotFoundError, parseJsonArray, truncate, ValidationError } from '../util.ts';
import { enqueueEmbedding } from './embeddings.ts';

export function toNote(r: any, tags: string[]): Note {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    quote: r.quote,
    location: r.location,
    sourceId: r.source_id,
    sourceTitle: r.source_title ?? null,
    aliases: parseJsonArray(r.aliases),
    tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Default title: first heading or first line of the body, or the quote for highlights. */
function deriveTitle(input: { title?: string; body?: string; quote?: string | null }): string {
  if (input.title?.trim()) return input.title.trim();
  const heading = input.body?.match(/^#{1,6}\s+(.+)$/m)?.[1];
  if (heading) return truncate(heading, 80);
  const text = input.quote?.trim() || input.body?.trim() || '';
  if (!text) throw new ValidationError('A note needs a title, body or quote');
  return truncate(text.split('\n')[0].replace(/[#*_>`]/g, ''), 80);
}

export interface NoteListOpts {
  sourceId?: string;
  kind?: NoteKind | NoteKind[];
  tag?: string;
  limit?: number;
  offset?: number;
  sort?: 'recent' | 'title' | 'location' | 'created';
}

const SELECT = `SELECT n.*, s.title AS source_title FROM notes n LEFT JOIN sources s ON s.id = n.source_id`;

export function createNotes(ctx: Ctx, tags: Tags, links: Links) {
  const { db } = ctx;

  function get(id: string): Note {
    const r = db.get(`${SELECT} WHERE n.id = ?`, [id]);
    if (!r) throw new NotFoundError('note', id);
    return toNote(r, tags.get('note', id));
  }

  function afterSave(id: string, body: string, names: string[]): void {
    links.syncWikilinks(id, body);
    links.resolveDangling('note', id, names);
    enqueueEmbedding(db, 'note', id);
    for (const f of ctx.onNoteSaved) f(id);
  }

  function create(input: NoteCreate): Note {
    if (input.sourceId && !db.get('SELECT 1 FROM sources WHERE id = ?', [input.sourceId])) {
      throw new NotFoundError('source', input.sourceId);
    }
    if (input.dedupeKey) {
      const dup = db.get<{ id: string }>('SELECT id FROM notes WHERE dedupe_key = ?', [input.dedupeKey]);
      if (dup) return get(dup.id);
    }
    const id = newId();
    const now = nowIso();
    const title = deriveTitle(input);
    const aliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    const body = input.body ?? '';
    db.tx(() => {
      db.run(
        `INSERT INTO notes (id, kind, title, body, quote, location, source_id, aliases, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.kind ?? (input.quote ? 'highlight' : 'note'),
          title,
          body,
          input.quote?.trim() || null,
          input.location?.trim() || null,
          input.sourceId ?? null,
          aliases,
          input.dedupeKey ?? null,
          now,
          now,
        ],
      );
      if (input.tags?.length) tags.set('note', id, input.tags);
      afterSave(id, body, [title, ...aliases]);
    });
    ctx.onIndexNeeded.forEach((f) => f());
    return get(id);
  }

  function update(id: string, patch: NotePatch): Note {
    const cur = get(id);
    if (patch.sourceId && !db.get('SELECT 1 FROM sources WHERE id = ?', [patch.sourceId])) {
      throw new NotFoundError('source', patch.sourceId);
    }
    const title = patch.title !== undefined ? deriveTitle({ ...cur, ...patch }) : cur.title;
    const aliases = patch.aliases ? patch.aliases.map((a) => a.trim()).filter(Boolean) : cur.aliases;
    const body = patch.body ?? cur.body;
    db.tx(() => {
      db.run(
        `UPDATE notes SET kind = ?, title = ?, body = ?, quote = ?, location = ?, source_id = ?, aliases = ?, updated_at = ?
         WHERE id = ?`,
        [
          patch.kind ?? cur.kind,
          title,
          body,
          patch.quote !== undefined ? patch.quote?.trim() || null : cur.quote,
          patch.location !== undefined ? patch.location?.trim() || null : cur.location,
          patch.sourceId !== undefined ? patch.sourceId : cur.sourceId,
          aliases,
          nowIso(),
          id,
        ],
      );
      if (patch.tags) tags.set('note', id, patch.tags);
      afterSave(id, body, [title, ...aliases]);
    });
    ctx.onIndexNeeded.forEach((f) => f());
    return get(id);
  }

  function remove(id: string): void {
    const r = db.run('DELETE FROM notes WHERE id = ?', [id]);
    if (!r.changes) throw new NotFoundError('note', id);
  }

  function list(opts: NoteListOpts = {}): { items: Note[]; total: number } {
    const where: string[] = [];
    const p: Record<string, unknown> = {};
    if (opts.sourceId) {
      where.push('n.source_id = :sourceId');
      p.sourceId = opts.sourceId;
    }
    if (opts.kind) {
      where.push('n.kind IN (SELECT value FROM json_each(:kinds))');
      p.kinds = JSON.stringify(Array.isArray(opts.kind) ? opts.kind : [opts.kind]);
    }
    if (opts.tag) {
      where.push(`n.id IN (SELECT it.item_id FROM item_tags it JOIN tags t ON t.id = it.tag_id
        WHERE it.item_type = 'note' AND (t.name = :tag OR t.name LIKE :tag || '/%'))`);
      p.tag = opts.tag;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      opts.sort === 'title'
        ? 'ORDER BY n.title COLLATE NOCASE'
        : opts.sort === 'created'
          ? 'ORDER BY n.created_at'
          : opts.sort === 'location'
            ? // numeric-aware ordering of "p. 12", "loc 340" etc., falling back to creation order
              `ORDER BY CAST(ltrim(n.location, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ. :') AS INTEGER), n.created_at`
            : 'ORDER BY n.updated_at DESC';
    const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM notes n ${w}`, p)!.n;
    const rows = db.all(`${SELECT} ${w} ${order} LIMIT :limit OFFSET :offset`, {
      ...p,
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
    });
    const tagMap = tags.getMany('note', rows.map((r) => r.id));
    return { items: rows.map((r) => toNote(r, tagMap.get(r.id) ?? [])), total };
  }

  /** Title autocomplete for [[wikilinks]]: notes (incl. aliases) and sources. */
  function suggestTitles(prefix: string, limit = 10): { type: 'note' | 'source'; id: string; title: string; kind: string }[] {
    return db.all(
      `SELECT * FROM (
         SELECT 'note' AS type, id, title, kind, updated_at FROM notes WHERE title LIKE :p || '%' OR title LIKE '% ' || :p || '%'
         UNION ALL
         SELECT 'source' AS type, id, title, kind, updated_at FROM sources WHERE title LIKE :p || '%' OR title LIKE '% ' || :p || '%'
       ) ORDER BY (title LIKE :p || '%') DESC, updated_at DESC LIMIT :limit`,
      { p: prefix, limit },
    );
  }

  return { get, create, update, remove, list, suggestTitles };
}
export type Notes = ReturnType<typeof createNotes>;
