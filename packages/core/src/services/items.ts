import type { Db } from '../db.ts';
import type { ItemRef, ItemType } from '../types.ts';

/** Batch-resolve {type,id} pairs to display refs (title, kind, source). Missing items are omitted. */
export function describeItems(db: Db, items: { type: ItemType; id: string }[]): Map<string, ItemRef> {
  const out = new Map<string, ItemRef>();
  const noteIds = [...new Set(items.filter((i) => i.type === 'note').map((i) => i.id))];
  const sourceIds = [...new Set(items.filter((i) => i.type === 'source').map((i) => i.id))];
  if (noteIds.length) {
    for (const r of db.all(
      `SELECT n.id, n.title, n.kind, n.source_id, s.title AS source_title
       FROM notes n LEFT JOIN sources s ON s.id = n.source_id
       WHERE n.id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(noteIds)],
    )) {
      out.set(`note:${r.id}`, { type: 'note', id: r.id, title: r.title, kind: r.kind, sourceId: r.source_id, sourceTitle: r.source_title });
    }
  }
  if (sourceIds.length) {
    for (const r of db.all(`SELECT id, title, kind FROM sources WHERE id IN (SELECT value FROM json_each(?))`, [
      JSON.stringify(sourceIds),
    ])) {
      out.set(`source:${r.id}`, { type: 'source', id: r.id, title: r.title, kind: r.kind, sourceId: r.id, sourceTitle: r.title });
    }
  }
  return out;
}

export function itemExists(db: Db, type: ItemType, id: string): boolean {
  const table = type === 'note' ? 'notes' : 'sources';
  return !!db.get(`SELECT 1 FROM ${table} WHERE id = ?`, [id]);
}

/** The source an item belongs to: a source is its own; a note's is its source_id, or the note itself if standalone. */
export function provenanceKey(db: Db, type: ItemType, id: string): string {
  if (type === 'source') return `source:${id}`;
  const r = db.get<{ source_id: string | null }>('SELECT source_id FROM notes WHERE id = ?', [id]);
  return r?.source_id ? `source:${r.source_id}` : `note:${id}`;
}
