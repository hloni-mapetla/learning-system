import type { Ctx } from './context.ts';
import type { Note, RecallState, Source } from '../types.ts';
import { FEELS_HARDER_NOTE, RECALL_PROMPT } from '../types.ts';
import type { Notes } from './notes.ts';
import type { Sources } from './sources.ts';
import { drainEmbedQueue, type VectorIndex } from './embeddings.ts';
import { localDate, ValidationError } from '../util.ts';

/**
 * Generation-first processing of a source: blank-page recall BEFORE looking at highlights, then a comparison
 * of what was recalled against what was highlighted. Claude does the judging; this service only stores the
 * recall, tracks the method used (for the recall-first experiment) and lines the material up.
 */

export interface RecallStatus {
  source: { id: string; title: string; status: string; method: Source['method'] };
  state: RecallState;
  /** How many highlights exist (their text is deliberately not included). */
  highlightCount: number;
  recalls: { id: string; createdAt: string; chars: number }[];
  prompt: string;
  note: string;
}

export interface RecallComparison {
  source: { id: string; title: string; method: Source['method'] };
  recalls: { id: string; createdAt: string; text: string }[];
  /**
   * Highlights with a similarity hint: how close the nearest recalled fragment is (0–1, null without an embedder).
   * Low scores are likely misses; Claude still judges, since paraphrase and errors aren't visible to a vector.
   */
  highlights: { id: string; quote: string; comment: string | null; location: string | null; similarity: number | null; nearestFragment: string | null }[];
  /** The learner's own notes on this source (concepts, claims, explanations…), to critique rather than duplicate. */
  ownNotes: { id: string; kind: string; title: string; body: string }[];
  claudeNotes: number;
}

/** Split a recall into fragments (sentences / bullet points) for the similarity hint. */
export function recallFragments(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 12);
}

export function createProcessing(ctx: Ctx, sources: Sources, notes: Notes, index: VectorIndex) {
  const { db } = ctx;

  function recallNotes(sourceId: string) {
    return db.all<{ id: string; body: string; created_at: string }>(
      `SELECT id, body, created_at FROM notes WHERE source_id = ? AND kind = 'recall' ORDER BY created_at, rowid`,
      [sourceId],
    );
  }

  function stateOf(sourceId: string): RecallState {
    if (recallNotes(sourceId).length) return 'done';
    return sources.get(sourceId).method === 'highlights_first' ? 'skipped' : 'none';
  }

  function status(sourceId: string): RecallStatus {
    const s = sources.get(sourceId);
    const recalls = recallNotes(sourceId);
    return {
      source: { id: s.id, title: s.title, status: s.status, method: s.method },
      state: stateOf(sourceId),
      highlightCount: db.get<{ n: number }>(`SELECT count(*) AS n FROM notes WHERE source_id = ? AND kind = 'highlight'`, [sourceId])!.n,
      recalls: recalls.map((r) => ({ id: r.id, createdAt: r.created_at, chars: r.body.length })),
      prompt: RECALL_PROMPT,
      note: FEELS_HARDER_NOTE,
    };
  }

  /**
   * Save a blank-page recall verbatim. The first recall on an unprocessed source marks it recall_first; a recall
   * written after the highlights were already shown (method highlights_first) keeps that method.
   */
  function saveRecall(sourceId: string, text: string): Note {
    const body = text.trim();
    if (!body) throw new ValidationError('A recall needs some text, even fragments');
    const s = sources.get(sourceId);
    return db.tx(() => {
      const n = notes.create({ kind: 'recall', title: `Recall: ${s.title} (${localDate()})`, body, sourceId }, 'user');
      const patch: Parameters<Sources['update']>[1] = {};
      if (!s.method) patch.method = 'recall_first';
      if (s.status === 'queued') patch.status = 'reading';
      if (Object.keys(patch).length) sources.update(sourceId, patch);
      return n;
    });
  }

  /** Explicitly skip the recall: highlights become visible and the source counts as highlights_first. */
  function skipRecall(sourceId: string): RecallStatus {
    const s = sources.get(sourceId);
    if (!s.method) sources.update(sourceId, { method: 'highlights_first' });
    return status(sourceId);
  }

  async function compare(sourceId: string): Promise<RecallComparison> {
    const s = sources.get(sourceId);
    const recalls = recallNotes(sourceId);
    const highlights = db.all<{ id: string; quote: string | null; body: string; location: string | null }>(
      `SELECT id, quote, body, location FROM notes WHERE source_id = ? AND kind = 'highlight' ORDER BY rowid`,
      [sourceId],
    );
    const fragments = recalls.flatMap((r) => recallFragments(r.body));
    const sims = new Map<string, { score: number; fragment: string }>();
    const embedder = ctx.embedder;
    if (embedder && fragments.length && highlights.length) {
      await drainEmbedQueue(db, embedder);
      const fv = await embedder.embedDocuments(fragments);
      for (const h of highlights) {
        let best = { score: -1, fragment: '' };
        for (const hv of index.vectorsOf(embedder.model, 'note', h.id)) {
          fv.forEach((f, i) => {
            let dot = 0;
            for (let j = 0; j < f.length; j++) dot += f[j] * hv[j];
            if (dot > best.score) best = { score: dot, fragment: fragments[i] };
          });
        }
        if (best.score > -1) sims.set(h.id, best);
      }
    }
    const own = db.all<{ id: string; kind: string; title: string; body: string }>(
      `SELECT id, kind, title, body FROM notes WHERE source_id = ? AND created_by = 'user' AND kind NOT IN ('highlight', 'recall')
       ORDER BY created_at`,
      [sourceId],
    );
    return {
      source: { id: s.id, title: s.title, method: s.method },
      recalls: recalls.map((r) => ({ id: r.id, createdAt: r.created_at, text: r.body })),
      highlights: highlights.map((h) => {
        const m = sims.get(h.id);
        return {
          id: h.id,
          quote: h.quote ?? '',
          comment: h.body || null,
          location: h.location,
          similarity: m ? Math.round(Math.max(0, m.score) * 100) / 100 : null,
          nearestFragment: m?.fragment ?? null,
        };
      }),
      ownNotes: own,
      claudeNotes: db.get<{ n: number }>(`SELECT count(*) AS n FROM notes WHERE source_id = ? AND created_by = 'claude'`, [sourceId])!.n,
    };
  }

  return { status, stateOf, saveRecall, skipRecall, compare };
}
export type Processing = ReturnType<typeof createProcessing>;
