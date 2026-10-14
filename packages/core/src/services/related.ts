import type { Ctx } from './context.ts';
import type { ItemType, Link } from '../types.ts';
import type { Links } from './links.ts';
import type { Search } from './search.ts';
import { describeItems, provenanceKey } from './items.ts';
import { drainEmbedQueue, type VectorIndex } from './embeddings.ts';
import { NotFoundError, truncate } from '../util.ts';

export interface SimilarItem {
  type: ItemType;
  id: string;
  title: string;
  kind: string;
  sourceId: string | null;
  sourceTitle: string | null;
  score: number;
  snippet: string;
  sameSource: boolean;
  alreadyLinked: boolean;
}

/** Find what an id refers to. ULIDs are unique across tables. */
export function findItem(ctx: Ctx, id: string): { type: ItemType | 'card'; id: string } {
  const { db } = ctx;
  if (db.get('SELECT 1 FROM notes WHERE id = ?', [id])) return { type: 'note', id };
  if (db.get('SELECT 1 FROM sources WHERE id = ?', [id])) return { type: 'source', id };
  if (db.get('SELECT 1 FROM cards WHERE id = ?', [id])) return { type: 'card', id };
  throw new NotFoundError('item', id);
}

export function createRelated(ctx: Ctx, links: Links, search: Search, index: VectorIndex) {
  const { db } = ctx;

  function linkedKeys(type: ItemType, id: string): Set<string> {
    const keys = new Set<string>();
    for (const r of db.all<{ k: string }>(
      `SELECT to_type || ':' || to_id AS k FROM links WHERE from_type = ? AND from_id = ? AND to_id IS NOT NULL
       UNION SELECT from_type || ':' || from_id FROM links WHERE to_type = ? AND to_id = ?`,
      [type, id, type, id],
    ))
      keys.add(r.k);
    return keys;
  }

  /** Semantically similar notes/sources. Falls back to keyword search on the title without an embedder. */
  async function similar(
    type: ItemType,
    id: string,
    opts: { limit?: number; crossSourceOnly?: boolean; excludeLinked?: boolean; minScore?: number } = {},
  ): Promise<SimilarItem[]> {
    const limit = opts.limit ?? 8;
    const self = describeItems(db, [{ type, id }]).get(`${type}:${id}`);
    if (!self) throw new NotFoundError(type, id);
    const selfProv = provenanceKey(db, type, id);
    const linked = linkedKeys(type, id);
    const keep = (t: ItemType, i: string) => {
      if (t === type && i === id) return false;
      if (type === 'note' && t === 'source' && self.sourceId === i) return false; // a note's own source is trivially related
      if (opts.crossSourceOnly && provenanceKey(db, t, i) === selfProv) return false;
      if (opts.excludeLinked && linked.has(`${t}:${i}`)) return false;
      return true;
    };

    let hits: { type: ItemType; id: string; score: number; chunk: string }[] = [];
    const embedder = ctx.embedder;
    if (embedder) {
      await drainEmbedQueue(db, embedder);
      const vecs = index.vectorsOf(embedder.model, type, id);
      if (vecs.length) {
        hits = index.search(embedder.model, vecs, limit * 3, keep);
        const floor = opts.minScore ?? embedder.minScore ?? 0;
        hits = hits.filter((h) => h.score >= floor);
      }
    } else {
      hits = search
        .fullText(self.title, { types: ['note', 'source'], limit: limit * 3 })
        .filter((h) => h.type !== 'card' && keep(h.type as ItemType, h.id))
        .map((h) => ({ type: h.type as ItemType, id: h.id, score: h.score, chunk: h.snippet }));
    }
    const refs = describeItems(db, hits);
    return hits.slice(0, limit).flatMap((h) => {
      const r = refs.get(`${h.type}:${h.id}`);
      if (!r) return [];
      return [
        {
          type: h.type,
          id: h.id,
          title: r.title,
          kind: r.kind,
          sourceId: r.sourceId ?? null,
          sourceTitle: r.sourceTitle ?? null,
          score: Math.round(h.score * 1000) / 1000,
          snippet: truncate((h.chunk.split('\n\n').slice(1).join(' ') || h.chunk).replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/g, '$1'), 220),
          sameSource: provenanceKey(db, h.type, h.id) === selfProv,
          alreadyLinked: linked.has(`${h.type}:${h.id}`),
        },
      ];
    });
  }

  async function related(type: ItemType, id: string, limit = 8): Promise<{ outgoing: Link[]; backlinks: Link[]; similar: SimilarItem[] }> {
    return { ...links.forItem(type, id), similar: await similar(type, id, { limit, excludeLinked: true }) };
  }

  /**
   * Candidate cross-source connections for Claude to evaluate. For an item: its nearest neighbours from other
   * sources that aren't linked yet. For a topic: pairs among the topic's notes and their cross-source neighbours.
   */
  async function connections(
    target: { type: ItemType; id: string } | { items: { type: ItemType; id: string }[] },
    limit = 12,
  ): Promise<{ a: SimilarItem | { type: ItemType; id: string; title: string; sourceTitle: string | null }; b: SimilarItem; score: number }[]> {
    const seeds = 'items' in target ? target.items.slice(0, 8) : [target];
    const perSeed = 'items' in target ? 4 : limit;
    const seen = new Set<string>();
    const out: { a: any; b: SimilarItem; score: number }[] = [];
    const seedRefs = describeItems(db, seeds);
    for (const seed of seeds) {
      const ref = seedRefs.get(`${seed.type}:${seed.id}`);
      if (!ref) continue;
      for (const b of await similar(seed.type, seed.id, { limit: perSeed, crossSourceOnly: true, excludeLinked: true })) {
        const key = [`${seed.type}:${seed.id}`, `${b.type}:${b.id}`].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a: { type: seed.type, id: seed.id, title: ref.title, sourceTitle: ref.sourceTitle ?? null }, b, score: b.score });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit);
  }

  return { similar, related, connections, findItem: (id: string) => findItem(ctx, id) };
}
export type Related = ReturnType<typeof createRelated>;
