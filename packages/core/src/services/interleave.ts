import type { Db } from '../db.ts';

/** FNV-1a: a stable 32-bit hash of a string (for seeds). */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG, so a day's order is reproducible (and testable). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const rnd = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** What makes two cards "the same material": their note, their source, their primary topic. */
export interface CardKeys {
  note: string | null;
  source: string | null;
  topic: string | null;
}

/**
 * Keys per card. Note: the card's own note, else the first note it refers to. Source: that note's source, else the first
 * source it refers to. Topic: the card's first tag, else its note's, else its source's.
 */
export function cardKeys(db: Db, ids: string[]): Map<string, CardKeys> {
  if (!ids.length) return new Map();
  const rows = db.all<{ id: string; note: string | null; source: string | null; topic: string | null }>(
    `WITH c AS (
       SELECT c.id,
         coalesce(c.note_id, (SELECT ref_id FROM card_refs WHERE card_id = c.id AND ref_type = 'note' ORDER BY rowid LIMIT 1)) AS note,
         (SELECT ref_id FROM card_refs WHERE card_id = c.id AND ref_type = 'source' ORDER BY rowid LIMIT 1) AS src_ref
       FROM cards c WHERE c.id IN (SELECT value FROM json_each(:ids)))
     SELECT c.id, c.note, coalesce(n.source_id, c.src_ref) AS source,
       coalesce(
         (SELECT min(t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_type = 'card' AND it.item_id = c.id),
         (SELECT min(t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_type = 'note' AND it.item_id = c.note),
         (SELECT min(t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_type = 'source' AND it.item_id = coalesce(n.source_id, c.src_ref))
       ) AS topic
     FROM c LEFT JOIN notes n ON n.id = c.note`,
    { ids: JSON.stringify(ids) },
  );
  return new Map(rows.map((r) => [r.id, { note: r.note, source: r.source, topic: r.topic }]));
}

/**
 * Interleave: a seeded shuffle, then a greedy pass that never puts two cards from the same note side by side when it can
 * avoid it, and spreads cards from the same source and topic. Cards in `early` (learning steps, which are time-sensitive)
 * are pulled toward the front but still kept apart from their neighbours.
 */
export function interleave<T extends { id: string }>(items: T[], keys: Map<string, Partial<CardKeys>>, seed: number, early: Set<string> = new Set()): T[] {
  const pool = seededShuffle(items, seed);
  const out: T[] = [];
  const same = (a: T | undefined, b: T, k: keyof CardKeys) => {
    if (!a) return false;
    const x = keys.get(a.id)?.[k];
    return x != null && x === keys.get(b.id)?.[k];
  };
  // Cards left per note: drawing from the biggest group first keeps it from piling up at the end.
  const left = new Map<string, number>();
  for (const c of pool) {
    const n = keys.get(c.id)?.note;
    if (n != null) left.set(n, (left.get(n) ?? 0) + 1);
  }
  while (pool.length) {
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const last = out.at(-1);
      const prev = out.at(-2);
      let score = 0;
      if (same(last, c, 'note')) score += 1000;
      if (same(prev, c, 'note')) score += 100;
      if (same(last, c, 'source')) score += 30;
      if (same(last, c, 'topic')) score += 20;
      if (same(prev, c, 'source')) score += 5;
      if (same(prev, c, 'topic')) score += 3;
      if (early.has(c.id)) score -= 500;
      const n = keys.get(c.id)?.note;
      if (n != null) score -= left.get(n)! / (left.get(n)! + 1); // < 1: only breaks ties between otherwise equal picks
      // Ties keep the shuffled order.
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const picked = pool.splice(best, 1)[0];
    const pn = keys.get(picked.id)?.note;
    if (pn != null) left.set(pn, left.get(pn)! - 1);
    out.push(picked);
  }
  return out;
}

/** How many adjacent pairs share a key (lower is better interleaving); for tests and stats. */
export function adjacentRepeats<T extends { id: string }>(items: T[], keys: Map<string, Partial<CardKeys>>, k: keyof CardKeys): number {
  let n = 0;
  for (let i = 1; i < items.length; i++) {
    const a = keys.get(items[i - 1].id)?.[k];
    if (a != null && a === keys.get(items[i].id)?.[k]) n++;
  }
  return n;
}
