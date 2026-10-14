import type { Ctx } from './context.ts';

export type TagItemType = 'note' | 'source' | 'card';

export function normalizeTag(t: string): string {
  return t.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
}

/** SQL fragment matching a topic: the tag itself or any child (topic "history" matches "history/boer-war"). */
export const TOPIC_MATCH = `(t.name = :topic OR t.name LIKE :topic || '/%')`;

export function createTags(ctx: Ctx) {
  const { db } = ctx;

  function set(itemType: TagItemType, itemId: string, names: string[]): void {
    db.tx(() => {
      db.run('DELETE FROM item_tags WHERE item_type = ? AND item_id = ?', [itemType, itemId]);
      for (const name of new Set(names.map(normalizeTag).filter(Boolean))) {
        db.run('INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [name]);
        db.run(
          'INSERT OR IGNORE INTO item_tags (tag_id, item_type, item_id) SELECT id, ?, ? FROM tags WHERE name = ?',
          [itemType, itemId, name],
        );
      }
    });
  }

  function get(itemType: TagItemType, itemId: string): string[] {
    return db
      .all<{ name: string }>(
        `SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
         WHERE it.item_type = ? AND it.item_id = ? ORDER BY t.name`,
        [itemType, itemId],
      )
      .map((r) => r.name);
  }

  function getMany(itemType: TagItemType, ids: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    const rows = db.all<{ item_id: string; name: string }>(
      `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
       WHERE it.item_type = ? AND it.item_id IN (SELECT value FROM json_each(?)) ORDER BY t.name`,
      [itemType, JSON.stringify(ids)],
    );
    for (const r of rows) {
      const list = out.get(r.item_id) ?? [];
      list.push(r.name);
      out.set(r.item_id, list);
    }
    return out;
  }

  function list(): { name: string; notes: number; sources: number; cards: number }[] {
    db.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags)');
    return db.all(
      `SELECT t.name,
         sum(it.item_type = 'note') AS notes,
         sum(it.item_type = 'source') AS sources,
         sum(it.item_type = 'card') AS cards
       FROM tags t JOIN item_tags it ON it.tag_id = t.id
       GROUP BY t.id ORDER BY t.name`,
    );
  }

  return { set, get, getMany, list };
}
export type Tags = ReturnType<typeof createTags>;
