import { createLoom, type Embedder } from '../src/index.ts';

const SYNONYMS: Record<string, string> = { car: 'vehicle', automobile: 'vehicle', auto: 'vehicle', happy: 'joy', glad: 'joy' };

/** Deterministic bag-of-words embedder with a tiny synonym table, for tests. */
export function fakeEmbedder(dim = 128): Embedder {
  const embed = (t: string) => {
    const v = new Float32Array(dim);
    for (const raw of t.toLowerCase().match(/[a-z]+/g) ?? []) {
      const w = SYNONYMS[raw] ?? raw;
      let h = 2166136261;
      for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      v[Math.abs(h) % dim] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  return {
    model: 'fake-bow',
    dim,
    embedDocuments: async (ts) => ts.map(embed),
    embedQuery: async (q) => embed(q),
  };
}

export function testLoom() {
  return createLoom({ dbPath: ':memory:', embedder: fakeEmbedder() });
}
