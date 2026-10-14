import type { Ctx } from './context.ts';
import type { ItemType, SearchHit } from '../types.ts';
import { drainEmbedQueue, type VectorIndex } from './embeddings.ts';
import { describeItems } from './items.ts';
import { truncate } from '../util.ts';

export type SearchType = 'note' | 'source' | 'card';

export interface SearchOpts {
  limit?: number;
  types?: SearchType[];
  /** Restrict notes to these kinds (note, highlight, concept, claim, summary). */
  noteKinds?: string[];
  sourceId?: string;
}

/** Build a safe FTS5 query: quoted tokens, prefix match on the last one. */
export function ftsQuery(q: string, mode: 'and' | 'or' = 'and'): string | null {
  const toks = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!toks.length) return null;
  return toks.map((t, i) => `"${t}"${i === toks.length - 1 && t.length > 1 ? '*' : ''}`).join(mode === 'and' ? ' ' : ' OR ');
}

const HL_OPEN = '**';
/** Semantic results more than this far below the best match are dropped from hybrid results. */
const SEMANTIC_BAND = 0.08;
const HL_CLOSE = '**';

export function createSearch(ctx: Ctx, index: VectorIndex) {
  const { db } = ctx;

  function fullText(q: string, opts: SearchOpts = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const types = opts.types ?? ['note', 'source', 'card'];
    for (const mode of ['and', 'or'] as const) {
      const fq = ftsQuery(q, mode);
      if (!fq) return [];
      const hits: SearchHit[] = [];
      if (types.includes('note')) {
        const rows = db.all(
          `SELECT n.id, n.title, n.kind, n.source_id, s.title AS source_title,
             snippet(notes_fts, -1, '${HL_OPEN}', '${HL_CLOSE}', '…', 16) AS snip,
             bm25(notes_fts, 0, 8, 1, 2) AS rank
           FROM notes_fts JOIN notes n ON n.id = notes_fts.id LEFT JOIN sources s ON s.id = n.source_id
           WHERE notes_fts MATCH :fq
             AND (:kinds IS NULL OR n.kind IN (SELECT value FROM json_each(:kinds)))
             AND (:src IS NULL OR n.source_id = :src)
           ORDER BY rank LIMIT :limit`,
          { fq, limit, kinds: opts.noteKinds ? JSON.stringify(opts.noteKinds) : null, src: opts.sourceId ?? null },
        );
        for (const r of rows)
          hits.push({ type: 'note', id: r.id, title: r.title, kind: r.kind, snippet: r.snip, sourceId: r.source_id,
            sourceTitle: r.source_title, score: -r.rank, matchedBy: ['text'] });
      }
      if (types.includes('source') && !opts.sourceId) {
        const rows = db.all(
          `SELECT s.id, s.title, s.kind, s.authors,
             snippet(sources_fts, -1, '${HL_OPEN}', '${HL_CLOSE}', '…', 16) AS snip, bm25(sources_fts, 0, 8, 4, 1) AS rank
           FROM sources_fts JOIN sources s ON s.id = sources_fts.id WHERE sources_fts MATCH :fq ORDER BY rank LIMIT :limit`,
          { fq, limit },
        );
        for (const r of rows)
          hits.push({ type: 'source', id: r.id, title: r.title, kind: r.kind, snippet: r.authors ? `${r.authors} — ${r.snip}` : r.snip,
            sourceId: r.id, sourceTitle: r.title, score: -r.rank, matchedBy: ['text'] });
      }
      if (types.includes('card') && !opts.sourceId) {
        const rows = db.all(
          `SELECT c.id, c.type, c.front, snippet(cards_fts, -1, '${HL_OPEN}', '${HL_CLOSE}', '…', 16) AS snip,
             bm25(cards_fts, 0, 2, 1) AS rank
           FROM cards_fts JOIN cards c ON c.id = cards_fts.id WHERE cards_fts MATCH :fq ORDER BY rank LIMIT :limit`,
          { fq, limit },
        );
        for (const r of rows)
          hits.push({ type: 'card', id: r.id, title: truncate(r.front.replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/g, '$1'), 80),
            kind: r.type, snippet: r.snip, sourceId: null, sourceTitle: null, score: -r.rank, matchedBy: ['text'] });
      }
      if (hits.length || mode === 'or') return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    }
    return [];
  }

  async function semantic(q: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const embedder = ctx.embedder;
    if (!embedder || !q.trim()) return [];
    await drainEmbedQueue(db, embedder);
    const limit = opts.limit ?? 20;
    const types = (opts.types ?? ['note', 'source']).filter((t): t is ItemType => t !== 'card');
    if (!types.length) return [];
    const qv = await embedder.embedQuery(q);
    let allowed: Set<string> | null = null;
    if (opts.noteKinds || opts.sourceId) {
      allowed = new Set(
        db
          .all<{ id: string }>(
            `SELECT id FROM notes WHERE (:kinds IS NULL OR kind IN (SELECT value FROM json_each(:kinds)))
               AND (:src IS NULL OR source_id = :src)`,
            { kinds: opts.noteKinds ? JSON.stringify(opts.noteKinds) : null, src: opts.sourceId ?? null },
          )
          .map((r) => `note:${r.id}`),
      );
    }
    const raw = index.search(embedder.model, [qv], limit, (type, id) => {
      if (!types.includes(type)) return false;
      if (type === 'source') return !opts.sourceId;
      return !allowed || allowed.has(`note:${id}`);
    });
    const refs = describeItems(db, raw);
    return raw
      .filter((h) => h.score >= (embedder.minScore ?? 0))
      .map((h) => {
        const ref = refs.get(`${h.type}:${h.id}`);
        if (!ref) return null;
        const body = (h.chunk.split('\n\n').slice(1).join(' ') || h.chunk).replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/g, '$1');
        return {
          type: h.type,
          id: h.id,
          title: ref.title,
          kind: ref.kind,
          snippet: truncate(body, 240),
          sourceId: ref.sourceId ?? null,
          sourceTitle: ref.sourceTitle ?? null,
          score: h.score,
          matchedBy: ['semantic'],
        } satisfies SearchHit;
      })
      .filter((h) => h !== null);
  }

  /** Reciprocal-rank fusion of full-text and semantic results. */
  async function hybrid(q: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 20;
    const text = fullText(q, { ...opts, limit: limit * 2 });
    // Dense-embedding scores sit in a narrow band, so keep only semantic hits close to the best one
    // (or the top few); otherwise loosely related items crowd out keyword matches.
    const semAll = await semantic(q, { ...opts, limit: limit * 2 });
    const top = semAll[0]?.score ?? 0;
    const sem = semAll.filter((h, i) => i < 3 || h.score >= top - SEMANTIC_BAND);
    const K = 60;
    const merged = new Map<string, SearchHit>();
    const add = (list: SearchHit[], weight: number) =>
      list.forEach((h, rank) => {
        const key = `${h.type}:${h.id}`;
        const prev = merged.get(key);
        const s = weight / (K + rank + 1);
        if (prev) {
          prev.score += s;
          prev.matchedBy = [...new Set([...prev.matchedBy, ...h.matchedBy])];
          if (h.matchedBy.includes('text')) prev.snippet = h.snippet; // keyword snippet is more telling
        } else merged.set(key, { ...h, score: s });
      });
    add(text, 1);
    add(sem, 1);
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return { fullText, semantic, hybrid };
}
export type Search = ReturnType<typeof createSearch>;
