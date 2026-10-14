import type { Ctx } from './context.ts';
import type { Actor, ItemType, Link, LinkRel } from '../types.ts';
import type { LinkCreate } from '../schemas.ts';
import { describeItems, itemExists } from './items.ts';
import { parseWikilinks } from './wikilinks.ts';
import { newId, nowIso, NotFoundError, ValidationError } from '../util.ts';

interface LinkRow {
  id: string;
  from_type: ItemType;
  from_id: string;
  to_type: ItemType;
  to_id: string | null;
  target_title: string | null;
  rel: LinkRel;
  rationale: string | null;
  created_by: Actor;
  created_at: string;
}

export function createLinks(ctx: Ctx) {
  const { db } = ctx;

  function hydrate(rows: LinkRow[]): Link[] {
    const refs = describeItems(db, [
      ...rows.map((r) => ({ type: r.from_type, id: r.from_id })),
      ...rows.filter((r) => r.to_id).map((r) => ({ type: r.to_type, id: r.to_id! })),
    ]);
    return rows
      .map((r) => ({
        id: r.id,
        rel: r.rel,
        from: refs.get(`${r.from_type}:${r.from_id}`)!,
        to: r.to_id ? (refs.get(`${r.to_type}:${r.to_id}`) ?? null) : null,
        targetTitle: r.target_title,
        rationale: r.rationale,
        createdBy: r.created_by,
        createdAt: r.created_at,
      }))
      .filter((l) => l.from);
  }

  function create(input: LinkCreate, createdBy: Actor = 'user'): Link {
    const { from, to, rel } = input;
    if (!itemExists(db, from.type, from.id)) throw new NotFoundError(from.type, from.id);
    if (!itemExists(db, to.type, to.id)) throw new NotFoundError(to.type, to.id);
    if (from.type === to.type && from.id === to.id) throw new ValidationError('Cannot link an item to itself');
    const existing = db.get<LinkRow>(
      `SELECT * FROM links WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND rel = ?`,
      [from.type, from.id, to.type, to.id, rel],
    );
    if (existing) {
      if (input.rationale && input.rationale !== existing.rationale) {
        db.run('UPDATE links SET rationale = ? WHERE id = ?', [input.rationale, existing.id]);
      }
      return get(existing.id);
    }
    const id = newId();
    db.run(
      `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, rationale, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, from.type, from.id, to.type, to.id, rel, input.rationale ?? null, createdBy, nowIso()],
    );
    return get(id);
  }

  function get(id: string): Link {
    const row = db.get<LinkRow>('SELECT * FROM links WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('link', id);
    return hydrate([row])[0];
  }

  function remove(id: string): void {
    const r = db.run(`DELETE FROM links WHERE id = ? AND rel <> 'wikilink'`, [id]);
    if (!r.changes) throw new NotFoundError('link (wikilinks are removed by editing the note)', id);
  }

  function forItem(type: ItemType, id: string): { outgoing: Link[]; backlinks: Link[] } {
    const outgoing = db.all<LinkRow>(
      'SELECT * FROM links WHERE from_type = ? AND from_id = ? ORDER BY rel, created_at',
      [type, id],
    );
    const incoming = db.all<LinkRow>('SELECT * FROM links WHERE to_type = ? AND to_id = ? ORDER BY rel, created_at', [
      type,
      id,
    ]);
    return { outgoing: hydrate(outgoing), backlinks: hydrate(incoming) };
  }

  /** Resolve a [[title]] to a note (by title, then alias) or a source (by title). */
  function resolveTitle(title: string): { type: ItemType; id: string } | null {
    const note =
      db.get<{ id: string }>('SELECT id FROM notes WHERE title = ? COLLATE NOCASE ORDER BY created_at LIMIT 1', [title]) ??
      db.get<{ id: string }>(
        `SELECT n.id FROM notes n, json_each(n.aliases) a WHERE a.value = ? COLLATE NOCASE ORDER BY n.created_at LIMIT 1`,
        [title],
      );
    if (note) return { type: 'note', id: note.id };
    const src = db.get<{ id: string }>('SELECT id FROM sources WHERE title = ? COLLATE NOCASE LIMIT 1', [title]);
    return src ? { type: 'source', id: src.id } : null;
  }

  /** Rebuild the wikilink rows for a note from its body. */
  function syncWikilinks(noteId: string, body: string): void {
    db.run(`DELETE FROM links WHERE from_type = 'note' AND from_id = ? AND rel = 'wikilink'`, [noteId]);
    const now = nowIso();
    for (const ref of parseWikilinks(body)) {
      const hit = resolveTitle(ref.target);
      if (hit && hit.type === 'note' && hit.id === noteId) continue;
      db.run(
        `INSERT INTO links (id, from_type, from_id, to_type, to_id, target_title, rel, created_by, created_at)
         VALUES (?, 'note', ?, ?, ?, ?, 'wikilink', 'system', ?)`,
        [newId(), noteId, hit?.type ?? 'note', hit?.id ?? null, ref.target, now],
      );
    }
  }

  /** Point dangling [[links]] at a newly created/renamed item. */
  function resolveDangling(type: ItemType, id: string, names: string[]): void {
    for (const name of names) {
      if (!name.trim()) continue;
      db.run(
        `UPDATE links SET to_type = ?, to_id = ? WHERE to_id IS NULL AND target_title = ? COLLATE NOCASE
           AND NOT (from_type = ? AND from_id = ?)`,
        [type, id, name.trim(), type, id],
      );
    }
  }

  function dangling(): { targetTitle: string; count: number }[] {
    return db.all(
      `SELECT target_title AS targetTitle, count(*) AS count FROM links WHERE to_id IS NULL
       GROUP BY target_title COLLATE NOCASE ORDER BY count DESC`,
    );
  }

  return { create, get, remove, forItem, resolveTitle, syncWikilinks, resolveDangling, dangling, hydrate };
}
export type Links = ReturnType<typeof createLinks>;
