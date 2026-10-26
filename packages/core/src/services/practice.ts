import type { Ctx } from './context.ts';
import type { CardView } from '../types.ts';
import type { Cards, CardRow } from './cards.ts';
import { CARDS_FOR_TAG_SQL, retrievability } from './cards.ts';
import type { Topics } from './topics.ts';
import type { Related } from './related.ts';
import type { SettingsService } from './settings.ts';
import { cardKeys, hashSeed, interleave } from './interleave.ts';
import { localDate, truncate, ValidationError } from '../util.ts';

export interface PracticeCard extends CardView {
  /** The topic this card was drawn for. */
  practiceTopic: string;
  /** Due now (else it's an early review of a weak card). */
  isDue: boolean;
}

export interface PracticeSet {
  topics: { topic: string; matchedBy: string; available: number; due: number; picked: number }[];
  cards: PracticeCard[];
}

export interface ConfusableSide {
  id: string;
  title: string;
  kind: string;
  topic: string;
  source: string | null;
  text: string;
}

export interface ConfusablePair {
  a: ConfusableSide;
  b: ConfusableSide;
  /** Why they're paired: an explicit link, or semantic similarity across topics. */
  reason: 'contradicts' | 'related' | 'similar';
  score: number | null;
  rationale: string | null;
}

/** Interleaved practice across topics, and pairs of ideas that are easy to mix up. */
export function createPractice(ctx: Ctx, cards: Cards, topics: Topics, related: Related, settings: SettingsService) {
  const { db } = ctx;

  async function cardIdsFor(topic: string): Promise<{ matchedBy: string; ids: string[] }> {
    const m = await topics.resolve(topic);
    if (m.matchedBy === 'tag') {
      return { matchedBy: 'tag', ids: db.all<{ card_id: string }>(CARDS_FOR_TAG_SQL, { topic: m.tag }).map((r) => r.card_id) };
    }
    return { matchedBy: m.matchedBy, ids: m.cardIds ?? [] };
  }

  /**
   * A practice set mixing 2+ topics: per topic, due cards first (most overdue), then (with includeNotDue) the
   * lowest-retrievability cards that aren't due yet. Topics take turns, then the set is interleaved so neighbours differ
   * in topic and note. New cards are left to the daily review.
   */
  async function practiceSet(opts: { topics: string[]; size?: number; includeNotDue?: boolean; seed?: string; now?: Date }): Promise<PracticeSet> {
    const names = [...new Set(opts.topics.map((t) => t.trim()).filter(Boolean))];
    if (names.length < 2) throw new ValidationError('Pick at least two topics to mix.');
    const now = opts.now ?? new Date();
    const size = Math.max(1, Math.min(100, opts.size ?? 20));
    const ahead = new Date(now.getTime() + settings.get().learnAheadMinutes * 60000).toISOString();
    const taken = new Set<string>();
    const queues: { topic: string; matchedBy: string; available: number; due: number; queue: { row: CardRow; isDue: boolean }[] }[] = [];
    for (const topic of names) {
      const { matchedBy, ids } = await cardIdsFor(topic);
      const rows = db.all<CardRow>(
        `SELECT * FROM cards WHERE id IN (SELECT value FROM json_each(?)) AND suspended = 0 AND state <> 0`,
        [JSON.stringify(ids)],
      );
      const isDue = (r: CardRow) => (r.state === 2 ? r.due <= now.toISOString() : r.due <= ahead);
      const due = rows.filter(isDue).sort((a, b) => a.due.localeCompare(b.due));
      const weak = opts.includeNotDue === false ? [] : rows.filter((r) => !isDue(r)).sort((a, b) => (retrievability(a, now) ?? 1) - (retrievability(b, now) ?? 1));
      queues.push({ topic, matchedBy, available: rows.length, due: due.length, queue: [...due.map((row) => ({ row, isDue: true })), ...weak.map((row) => ({ row, isDue: false }))] });
    }
    const picked: { row: CardRow; isDue: boolean; topic: string }[] = [];
    const count = new Map<string, number>();
    for (let progress = true; picked.length < size && progress; ) {
      progress = false;
      for (const q of queues) {
        if (picked.length >= size) break;
        while (q.queue.length && taken.has(q.queue[0].row.id)) q.queue.shift();
        const next = q.queue.shift();
        if (!next) continue;
        taken.add(next.row.id);
        picked.push({ ...next, topic: q.topic });
        count.set(q.topic, (count.get(q.topic) ?? 0) + 1);
        progress = true;
      }
    }
    const keys = cardKeys(db, picked.map((p) => p.row.id));
    for (const p of picked) keys.set(p.row.id, { ...keys.get(p.row.id)!, topic: p.topic });
    const seed = hashSeed(opts.seed ?? `practice:${localDate(now)}:${names.join('|')}`);
    const order = interleave(picked.map((p) => ({ ...p, id: p.row.id })), keys, seed);
    const views = new Map(cards.hydrate(order.map((p) => p.row), now).map((v) => [v.id, v]));
    return {
      topics: queues.map((q) => ({ topic: q.topic, matchedBy: q.matchedBy, available: q.available, due: q.due, picked: count.get(q.topic) ?? 0 })),
      cards: order.map((p) => ({ ...views.get(p.id)!, practiceTopic: p.topic, isDue: p.isDue })),
    };
  }

  /**
   * Pairs of concepts/claims that are easy to confuse, across the given topics: explicit contradicts/related links
   * first, then semantically similar notes that sit under a different topic. Each side carries its text.
   */
  async function confusables(opts: { topics: string[]; limit?: number }): Promise<ConfusablePair[]> {
    const names = [...new Set(opts.topics.map((t) => t.trim()).filter(Boolean))];
    if (!names.length) throw new ValidationError('Name at least one topic.');
    const limit = Math.max(1, Math.min(30, opts.limit ?? 8));
    const topicOf = new Map<string, string>();
    for (const topic of names) {
      const m = await topics.resolve(topic);
      const noteIds = m.items.filter((i) => i.type === 'note').map((i) => i.id);
      const ideas = db.all<{ id: string }>(
        `SELECT id FROM notes WHERE id IN (SELECT value FROM json_each(?)) AND kind IN ('concept', 'claim', 'note', 'summary', 'explanation') LIMIT 40`,
        [JSON.stringify(noteIds)],
      );
      for (const n of ideas) if (!topicOf.has(n.id)) topicOf.set(n.id, topic);
    }
    const ids = [...topicOf.keys()];
    const side = (id: string): ConfusableSide | null => {
      const n = db.get<{ id: string; title: string; kind: string; body: string; quote: string | null; source: string | null }>(
        `SELECT n.id, n.title, n.kind, n.body, n.quote, s.title AS source FROM notes n LEFT JOIN sources s ON s.id = n.source_id WHERE n.id = ?`,
        [id],
      );
      if (!n) return null;
      const text = truncate([n.quote, n.body].filter(Boolean).join('\n\n').replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/g, '$1'), 600);
      return { id: n.id, title: n.title, kind: n.kind, topic: topicOf.get(id) ?? '', source: n.source, text };
    };
    const pairs = new Map<string, ConfusablePair>();
    const add = (x: string, y: string, reason: ConfusablePair['reason'], score: number | null, rationale: string | null) => {
      const key = [x, y].sort().join('|');
      if (x === y || pairs.has(key)) return;
      const a = side(x);
      const b = side(y);
      if (a && b) pairs.set(key, { a, b, reason, score, rationale });
    };
    for (const l of db.all<{ from_id: string; to_id: string; rel: 'contradicts' | 'related'; rationale: string | null }>(
      `SELECT from_id, to_id, rel, rationale FROM links WHERE from_type = 'note' AND to_type = 'note' AND rel IN ('contradicts', 'related')
         AND from_id IN (SELECT value FROM json_each(:ids)) AND to_id IN (SELECT value FROM json_each(:ids))
       ORDER BY rel = 'related'`,
      { ids: JSON.stringify(ids) },
    )) {
      // Related ideas only count as confusable across topics; contradictions always do.
      if (l.rel === 'contradicts' || topicOf.get(l.from_id) !== topicOf.get(l.to_id)) add(l.from_id, l.to_id, l.rel, null, l.rationale);
    }
    const similar: { x: string; y: string; score: number }[] = [];
    for (const id of ids.slice(0, 60)) {
      for (const h of await related.similar('note', id, { limit: 6 })) {
        if (h.type === 'note' && topicOf.has(h.id) && topicOf.get(h.id) !== topicOf.get(id)) similar.push({ x: id, y: h.id, score: h.score });
      }
    }
    similar.sort((a, b) => b.score - a.score);
    for (const s of similar) add(s.x, s.y, 'similar', s.score, null);
    return [...pairs.values()].slice(0, limit);
  }

  return { practiceSet, confusables };
}
export type Practice = ReturnType<typeof createPractice>;
