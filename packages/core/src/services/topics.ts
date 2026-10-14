import type { Ctx } from './context.ts';
import type { Search } from './search.ts';
import { CARDS_FOR_ITEM_SQL } from './cards.ts';
import { normalizeTag } from './tags.ts';

export interface TopicMatch {
  /** How the topic was interpreted. */
  matchedBy: 'tag' | 'source' | 'search' | 'none';
  tag?: string;
  sources?: { id: string; title: string }[];
  /** Cards relevant to the topic (undefined when matched by tag: use the tag filter instead). */
  cardIds?: string[];
  /** Notes/sources relevant to the topic, best first. */
  items: { type: 'note' | 'source'; id: string }[];
}

/**
 * Interpret a free-form topic: an existing tag (or tag prefix), else a source title, else a
 * hybrid search over notes and sources whose cards are then collected.
 */
export function createTopics(ctx: Ctx, search: Search) {
  const { db } = ctx;

  async function resolve(topic: string, opts: { searchLimit?: number } = {}): Promise<TopicMatch> {
    const t = topic.trim();
    if (!t) return { matchedBy: 'none', items: [] };
    const tag = normalizeTag(t);
    const tagHit = db.get<{ name: string }>(`SELECT name FROM tags WHERE name = ? OR name LIKE ? || '/%' LIMIT 1`, [tag, tag]);
    if (tagHit) {
      const items = db.all<{ type: 'note' | 'source'; id: string }>(
        `SELECT it.item_type AS type, it.item_id AS id FROM item_tags it JOIN tags tg ON tg.id = it.tag_id
         WHERE it.item_type IN ('note', 'source') AND (tg.name = ? OR tg.name LIKE ? || '/%')`,
        [tag, tag],
      );
      return { matchedBy: 'tag', tag, items };
    }
    const sources = db.all<{ id: string; title: string }>(
      `SELECT id, title FROM sources WHERE title LIKE '%' || ? || '%' ORDER BY length(title) LIMIT 3`,
      [t],
    );
    if (sources.length && sources[0].title.length <= t.length * 3) {
      const cardIds = new Set<string>();
      for (const s of sources) {
        for (const r of db.all<{ card_id: string }>(CARDS_FOR_ITEM_SQL, { type: 'source', id: s.id })) cardIds.add(r.card_id);
      }
      const items = [
        ...sources.map((s) => ({ type: 'source' as const, id: s.id })),
        ...db.all<{ type: 'note'; id: string }>(
          `SELECT 'note' AS type, id FROM notes WHERE source_id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(sources.map((s) => s.id))],
        ),
      ];
      return { matchedBy: 'source', sources, cardIds: [...cardIds], items };
    }
    const hits = await search.hybrid(t, { limit: opts.searchLimit ?? 25, types: ['note', 'source'] });
    const cardIds = new Set<string>();
    for (const h of hits) {
      for (const r of db.all<{ card_id: string }>(CARDS_FOR_ITEM_SQL, { type: h.type, id: h.id })) cardIds.add(r.card_id);
    }
    for (const h of search.fullText(t, { types: ['card'], limit: 50 })) cardIds.add(h.id);
    return {
      matchedBy: 'search',
      cardIds: [...cardIds],
      items: hits.filter((h) => h.type !== 'card').map((h) => ({ type: h.type as 'note' | 'source', id: h.id })),
    };
  }

  return { resolve };
}
export type Topics = ReturnType<typeof createTopics>;
