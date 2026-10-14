import type { Ctx } from './context.ts';
import type { CardView } from '../types.ts';
import type { Cards } from './cards.ts';
import type { Review } from './review.ts';
import type { Topics, TopicMatch } from './topics.ts';
import { describeItems } from './items.ts';
import { truncate } from '../util.ts';

export interface StudyContext {
  topic: string;
  matchedBy: TopicMatch['matchedBy'];
  tag?: string;
  dueNow: number;
  totalCards: number;
  sources: { id: string; title: string; authors: string; status: string; notes: number; cards: number }[];
  notes: { id: string; title: string; kind: string; sourceTitle: string | null; location: string | null; text: string }[];
  weakCards: CardView[];
  recentLapses: { cardId: string; prompt: string; reviewedAt: string; notes: string | null }[];
  newCards: number;
}

/** Everything Claude needs to run a quiz or Socratic session on a topic. */
export function createStudy(ctx: Ctx, cards: Cards, review: Review, topics: Topics) {
  const { db } = ctx;

  async function context(topic: string, opts: { notes?: number; cards?: number } = {}): Promise<StudyContext> {
    const m = await topics.resolve(topic);
    const filter = m.matchedBy === 'tag' ? { tag: m.tag } : { ids: m.cardIds ?? [] };
    const all = cards.list({ ...filter, suspended: false, limit: 10_000 }).items;
    const weak = all
      .filter((c) => c.state !== 'new')
      .sort((a, b) => (a.retrievability ?? 1) - (b.retrievability ?? 1) || b.lapses - a.lapses)
      .slice(0, opts.cards ?? 10);
    const due = review.due(m.matchedBy === 'tag' ? { tag: m.tag, limit: 1000 } : { cardIds: m.cardIds ?? [], limit: 1000 });

    const noteRefs = m.items.filter((i) => i.type === 'note').slice(0, opts.notes ?? 12);
    const noteRows = noteRefs.length
      ? db.all(
          `SELECT n.id, n.title, n.kind, n.body, n.quote, n.location, s.title AS source_title
           FROM notes n LEFT JOIN sources s ON s.id = n.source_id WHERE n.id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(noteRefs.map((n) => n.id))],
        )
      : [];
    const order = new Map(noteRefs.map((n, i) => [n.id, i]));
    noteRows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

    const sourceIds = new Set<string>(m.items.filter((i) => i.type === 'source').map((i) => i.id));
    for (const r of noteRows) {
      const sid = db.get<{ source_id: string | null }>('SELECT source_id FROM notes WHERE id = ?', [r.id])?.source_id;
      if (sid) sourceIds.add(sid);
    }
    const srcRefs = describeItems(db, [...sourceIds].map((id) => ({ type: 'source' as const, id })));
    const sources = [...sourceIds].flatMap((id) => {
      const s = db.get('SELECT id, title, authors, status FROM sources WHERE id = ?', [id]);
      if (!s || !srcRefs.has(`source:${id}`)) return [];
      return [
        {
          ...s,
          notes: db.get<{ n: number }>('SELECT count(*) AS n FROM notes WHERE source_id = ?', [id])!.n,
          cards: cards.countForItem('source', id),
        } as StudyContext['sources'][number],
      ];
    });

    const ids = new Set(all.map((c) => c.id));
    const lapses = db
      .all<{ card_id: string; reviewed_at: string; notes: string | null }>(
        `SELECT card_id, reviewed_at, notes FROM review_logs WHERE rating = 1 ORDER BY reviewed_at DESC LIMIT 200`,
      )
      .filter((l) => ids.has(l.card_id))
      .slice(0, 8)
      .map((l) => ({ cardId: l.card_id, prompt: all.find((c) => c.id === l.card_id)!.prompt, reviewedAt: l.reviewed_at, notes: l.notes }));

    return {
      topic,
      matchedBy: m.matchedBy,
      tag: m.tag,
      dueNow: due.length,
      totalCards: all.length,
      newCards: all.filter((c) => c.state === 'new').length,
      sources,
      notes: noteRows.map((n) => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        sourceTitle: n.source_title,
        location: n.location,
        text: truncate([n.quote ? `"${n.quote}"` : '', n.body].filter(Boolean).join('\n'), 700),
      })),
      weakCards: weak,
      recentLapses: lapses,
    };
  }

  return { context };
}
export type Study = ReturnType<typeof createStudy>;
