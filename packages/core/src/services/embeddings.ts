import type { Db } from '../db.ts';
import type { ItemType } from '../types.ts';
import { nowIso, sha1 } from '../util.ts';

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  /** Cosine score below which matches are treated as noise (model-specific). */
  readonly minScore?: number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/** Local ONNX embedder via transformers.js. The model downloads once into cacheDir, then runs offline. */
export function transformersEmbedder(opts: { model?: string; cacheDir?: string } = {}): Embedder {
  const model = opts.model ?? DEFAULT_MODEL;
  let pipe: Promise<any> | null = null;
  const load = () =>
    (pipe ??= (async () => {
      const t = await import('@huggingface/transformers');
      if (opts.cacheDir) t.env.cacheDir = opts.cacheDir;
      return t.pipeline('feature-extraction', model, { dtype: 'fp32' });
    })());

  async function run(texts: string[]): Promise<Float32Array[]> {
    const p = await load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const t = await p(batch, { pooling: 'cls', normalize: true });
      const [n, d] = t.dims as [number, number];
      const data = t.data as Float32Array;
      for (let j = 0; j < n; j++) out.push(data.slice(j * d, (j + 1) * d));
    }
    return out;
  }

  return {
    model,
    dim: 384,
    minScore: 0.45, // bge-small scores unrelated English text around 0.3–0.45
    embedDocuments: run,
    embedQuery: async (q) => (await run([BGE_QUERY_PREFIX + q]))[0],
  };
}

// ---- chunking ----

const MAX_CHARS = 1200;

/** Split text into paragraph-aligned chunks of at most ~MAX_CHARS, each prefixed with a header for context. */
export function chunkText(header: string, text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(`${header}\n\n${cur.trim()}`);
    cur = '';
  };
  for (const p of paras) {
    if (p.length > MAX_CHARS) {
      push();
      const sentences = p.match(/[^.!?]+[.!?]*\s*/g) ?? [p];
      for (const s of sentences) {
        if ((cur + s).length > MAX_CHARS) push();
        cur += s;
      }
      push();
    } else {
      if ((cur + '\n\n' + p).length > MAX_CHARS) push();
      cur += (cur ? '\n\n' : '') + p;
    }
  }
  push();
  return chunks.length ? chunks : [header];
}

function itemText(db: Db, type: ItemType, id: string): string[] | null {
  if (type === 'note') {
    const n = db.get(
      `SELECT n.title, n.body, n.quote, s.title AS source_title FROM notes n LEFT JOIN sources s ON s.id = n.source_id WHERE n.id = ?`,
      [id],
    );
    if (!n) return null;
    const header = n.source_title ? `${n.title} (from ${n.source_title})` : n.title;
    const text = [n.quote ? `"${n.quote}"` : '', n.body].filter(Boolean).join('\n\n');
    return chunkText(header, text);
  }
  const s = db.get('SELECT title, authors, description FROM sources WHERE id = ?', [id]);
  if (!s) return null;
  return chunkText(`${s.title}${s.authors ? ` by ${s.authors}` : ''}`, s.description);
}

export function enqueueEmbedding(db: Db, type: ItemType, id: string): void {
  db.run(
    `INSERT INTO embed_queue (owner_type, owner_id, queued_at) VALUES (?, ?, ?)
     ON CONFLICT DO UPDATE SET queued_at = excluded.queued_at`,
    [type, id, nowIso()],
  );
}

export function pendingEmbeddings(db: Db): number {
  return db.get<{ n: number }>('SELECT count(*) AS n FROM embed_queue')!.n;
}

/** Queue every item whose chunks are missing or were produced by a different model. */
export function enqueueAll(db: Db, model: string): number {
  const before = pendingEmbeddings(db);
  const now = nowIso();
  db.run(
    `INSERT OR IGNORE INTO embed_queue (owner_type, owner_id, queued_at)
     SELECT 'note', id, ? FROM notes WHERE id NOT IN (SELECT owner_id FROM chunks WHERE owner_type = 'note' AND model = ?)
     UNION ALL
     SELECT 'source', id, ? FROM sources WHERE id NOT IN (SELECT owner_id FROM chunks WHERE owner_type = 'source' AND model = ?)`,
    [now, model, now, model],
  );
  return pendingEmbeddings(db) - before;
}

const draining = new WeakMap<Db, Promise<number>>();

/** Embed everything in the queue. Re-entrant calls share one run. Returns items processed. */
export function drainEmbedQueue(db: Db, embedder: Embedder, batch = 32): Promise<number> {
  const running = draining.get(db);
  if (running) return running;
  const run = (async () => {
    let done = 0;
    try {
      for (;;) {
        const items = db.all<{ owner_type: ItemType; owner_id: string; queued_at: string }>(
          'SELECT * FROM embed_queue ORDER BY queued_at LIMIT ?',
          [batch],
        );
        if (!items.length) break;
        for (const it of items) {
          const chunks = itemText(db, it.owner_type, it.owner_id);
          if (!chunks) {
            db.run('DELETE FROM embed_queue WHERE owner_type = ? AND owner_id = ?', [it.owner_type, it.owner_id]);
            continue;
          }
          const existing = new Map(
            db
              .all<{ idx: number; hash: string; model: string }>(
                'SELECT idx, hash, model FROM chunks WHERE owner_type = ? AND owner_id = ?',
                [it.owner_type, it.owner_id],
              )
              .map((r) => [r.idx, r]),
          );
          const hashes = chunks.map(sha1);
          const todo = chunks
            .map((text, idx) => ({ text, idx, hash: hashes[idx] }))
            .filter((c) => {
              const e = existing.get(c.idx);
              return !e || e.hash !== c.hash || e.model !== embedder.model;
            });
          const vectors = todo.length ? await embedder.embedDocuments(todo.map((c) => c.text)) : [];
          db.tx(() => {
            // Skip if the item was edited again while we were embedding; the newer queue entry will redo it.
            const still = db.get<{ queued_at: string }>(
              'SELECT queued_at FROM embed_queue WHERE owner_type = ? AND owner_id = ?',
              [it.owner_type, it.owner_id],
            );
            if (still && still.queued_at !== it.queued_at) return;
            todo.forEach((c, i) => {
              db.run(
                `INSERT INTO chunks (owner_type, owner_id, idx, text, hash, model, vector) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (owner_type, owner_id, idx) DO UPDATE SET text = excluded.text, hash = excluded.hash,
                   model = excluded.model, vector = excluded.vector`,
                [it.owner_type, it.owner_id, c.idx, c.text, c.hash, embedder.model, vectors[i]],
              );
            });
            db.run('DELETE FROM chunks WHERE owner_type = ? AND owner_id = ? AND idx >= ?', [
              it.owner_type,
              it.owner_id,
              chunks.length,
            ]);
            db.run('DELETE FROM embed_queue WHERE owner_type = ? AND owner_id = ?', [it.owner_type, it.owner_id]);
          });
          done++;
        }
      }
    } finally {
      draining.delete(db);
    }
    return done;
  })();
  draining.set(db, run);
  return run;
}

// ---- in-memory vector index (brute-force cosine; vectors are pre-normalised) ----

export interface VectorHit {
  type: ItemType;
  id: string;
  score: number;
  chunk: string;
}

interface IndexSnapshot {
  version: string;
  model: string;
  dim: number;
  owners: { type: ItemType; id: string; chunk: string }[];
  matrix: Float32Array;
}

export class VectorIndex {
  #snap: IndexSnapshot | null = null;
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  #load(model: string): IndexSnapshot {
    const version = this.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'chunks_version'`)!.value;
    if (this.#snap && this.#snap.version === version && this.#snap.model === model) return this.#snap;
    const rows = this.db.all<{ owner_type: ItemType; owner_id: string; text: string; vector: Uint8Array }>(
      'SELECT owner_type, owner_id, text, vector FROM chunks WHERE model = ?',
      [model],
    );
    const dim = rows.length ? rows[0].vector.byteLength / 4 : 0;
    const matrix = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => {
      matrix.set(new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)), i * dim);
    });
    this.#snap = {
      version,
      model,
      dim,
      owners: rows.map((r) => ({ type: r.owner_type, id: r.owner_id, chunk: r.text })),
      matrix,
    };
    return this.#snap;
  }

  /** Top-k items by best-matching chunk. */
  search(model: string, queries: Float32Array[], k: number, filter?: (type: ItemType, id: string) => boolean): VectorHit[] {
    const s = this.#load(model);
    const best = new Map<string, VectorHit>();
    for (let i = 0; i < s.owners.length; i++) {
      const o = s.owners[i];
      if (filter && !filter(o.type, o.id)) continue;
      let score = -1;
      for (const q of queries) {
        let dot = 0;
        const off = i * s.dim;
        for (let j = 0; j < s.dim; j++) dot += q[j] * s.matrix[off + j];
        if (dot > score) score = dot;
      }
      const key = `${o.type}:${o.id}`;
      const prev = best.get(key);
      if (!prev || score > prev.score) best.set(key, { type: o.type, id: o.id, score, chunk: o.chunk });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** The stored vectors of one item (to find its neighbours without re-embedding). */
  vectorsOf(model: string, type: ItemType, id: string): Float32Array[] {
    const s = this.#load(model);
    const out: Float32Array[] = [];
    s.owners.forEach((o, i) => {
      if (o.type === type && o.id === id) out.push(s.matrix.subarray(i * s.dim, (i + 1) * s.dim));
    });
    return out;
  }
}
