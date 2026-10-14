import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CARD_TYPES,
  NOTE_KINDS,
  RATINGS,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  TYPED_LINK_RELS,
  schemas,
  type CardView,
  type ItemType,
  type Loom,
} from '@loom/core';

// ---- output shaping: compact JSON that keeps ids so Claude can chain calls ----

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

function pct(x: number | null): string | null {
  return x === null ? null : `${Math.round(x * 100)}%`;
}

/** A card as Claude sees it. `answer`/`rubric` are for grading only and must not be shown before the attempt. */
export function cardForClaude(c: CardView) {
  return {
    id: c.id,
    type: c.type,
    prompt: c.prompt,
    answer: c.answer || null,
    ...(c.hidden ? { hidden: c.hidden } : {}),
    ...(c.rubric ? { rubric: c.rubric } : {}),
    state: c.state,
    reps: c.reps,
    lapses: c.lapses,
    recall_now: pct(c.retrievability),
    from: c.refs.map((r) => (r.type === 'note' && r.sourceTitle ? `${r.title} (${r.sourceTitle})` : r.title)),
    ref_ids: c.refs.map((r) => r.id),
    tags: c.tags.length ? c.tags : undefined,
  };
}

const refSchema = z.object({ type: z.enum(['note', 'source']), id: z.string() });
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function registerTools(server: McpServer, loom: Loom) {
  const kick = () => loom.ctx.onIndexNeeded.forEach((f) => f());

  // ================= review =================

  server.registerTool(
    'get_due_cards',
    {
      title: 'Get due cards',
      description:
        'Cards due for spaced-repetition review now (learning steps first, then overdue reviews, then new cards within the daily limit). ' +
        'Each card includes its answer/hidden text/rubric FOR GRADING ONLY: show the learner only `prompt` until they have answered. ' +
        'Optional topic: a tag, source title, or free text (matched semantically).',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(10).describe('Max cards to return'),
        topic: z.string().optional().describe('Tag, source title, or free-text topic'),
        include_new: z.boolean().default(true).describe('Include never-reviewed cards'),
      },
      annotations: READ,
    },
    async ({ limit, topic, include_new }) => {
      let filter: { tag?: string; cardIds?: string[] } = {};
      let matchedBy: string | undefined;
      if (topic) {
        const m = await loom.topics.resolve(topic);
        matchedBy = m.matchedBy;
        filter = m.matchedBy === 'tag' ? { tag: m.tag } : { cardIds: m.cardIds ?? [] };
      }
      const cards = loom.review.due({ ...filter, limit, includeNew: include_new });
      return json({
        due_today: loom.review.counts(filter),
        ...(topic ? { topic, topic_matched_by: matchedBy } : {}),
        cards: cards.map(cardForClaude),
      });
    },
  );

  server.registerTool(
    'record_review',
    {
      title: 'Record review',
      description:
        'Record the result of reviewing a card and reschedule it with FSRS. Rating: again (failed/forgot), hard (recalled with significant ' +
        'difficulty or a hint), good (correct), easy (instant and complete). Add a one-line assessment in notes.',
      inputSchema: {
        card_id: z.string(),
        rating: z.enum(RATINGS),
        notes: z.string().optional().describe("One-line assessment of the learner's answer"),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ card_id, rating, notes }) => {
      const r = loom.review.record(card_id, rating, { grader: 'claude', notes });
      return json({
        card_id,
        rating: r.rating,
        next_review_in: r.nextIn,
        state: r.card.state,
        due: r.card.due,
        remaining_due_today: loom.review.counts().total,
      });
    },
  );

  server.registerTool(
    'undo_review',
    {
      title: 'Undo review',
      description: 'Undo the most recent review of a card (e.g. when the learner disputes a rating), restoring its previous schedule.',
      inputSchema: { card_id: z.string() },
      annotations: WRITE,
    },
    async ({ card_id }) => {
      const c = loom.review.undo(card_id);
      return json({ card_id, restored_state: c.state, due: c.due });
    },
  );

  server.registerTool(
    'get_card',
    {
      title: 'Get card',
      description: 'A card with its answer, refs and review history.',
      inputSchema: { card_id: z.string() },
      annotations: READ,
    },
    async ({ card_id }) => json({ ...cardForClaude(loom.cards.get(card_id)), history: loom.review.history(card_id).slice(0, 10) }),
  );

  // ================= knowledge: read =================

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search knowledge',
      description:
        "Search the user's notes, highlights, concepts, sources and cards. Hybrid keyword + semantic by default, so it finds ideas phrased differently. " +
        'Returns ids, titles, source and a snippet; use get_note/get_source for full text.',
      inputSchema: {
        query: z.string().min(1),
        semantic: z.boolean().default(true).describe('false = keyword-only (exact terms)'),
        limit: z.number().int().min(1).max(50).default(10),
        types: z.array(z.enum(['note', 'source', 'card'])).optional(),
        note_kinds: z.array(z.enum(NOTE_KINDS)).optional().describe('Restrict notes to these kinds'),
      },
      annotations: READ,
    },
    async ({ query, semantic, limit, types, note_kinds }) => {
      const opts = { limit, types, noteKinds: note_kinds };
      const hits = semantic ? await loom.search.hybrid(query, opts) : loom.search.fullText(query, opts);
      return json(
        hits.map((h) => ({
          type: h.type,
          id: h.id,
          kind: h.kind,
          title: h.title,
          source: h.type === 'note' ? h.sourceTitle : undefined,
          snippet: h.snippet,
          matched_by: h.matchedBy.join('+'),
        })),
      );
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Get note',
      description: 'Full note: body (Markdown with [[wikilinks]]), quote, source, tags, typed links, backlinks and cards.',
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    async ({ id }) => {
      const n = loom.noteDetail(id);
      const link = (l: (typeof n.outgoing)[number], dir: 'out' | 'in') => {
        const other = dir === 'out' ? l.to : l.from;
        return { link_id: l.id, rel: l.rel, id: other?.id ?? null, title: other?.title ?? l.targetTitle, rationale: l.rationale ?? undefined };
      };
      return json({
        id: n.id,
        kind: n.kind,
        title: n.title,
        source: n.sourceId ? { id: n.sourceId, title: n.sourceTitle } : null,
        location: n.location,
        quote: n.quote,
        body: n.body,
        tags: n.tags,
        aliases: n.aliases.length ? n.aliases : undefined,
        links: n.outgoing.map((l) => link(l, 'out')),
        backlinks: n.backlinks.map((l) => link(l, 'in')),
        cards: n.cards.map((c) => ({ id: c.id, type: c.type, prompt: c.prompt, state: c.state })),
        updated_at: n.updatedAt,
      });
    },
  );

  server.registerTool(
    'get_source',
    {
      title: 'Get source',
      description: 'A source (book/article/paper/video/lecture) with metadata, its highlights and notes, links and card count.',
      inputSchema: {
        id: z.string(),
        full_text: z.boolean().default(false).describe('Include full note bodies (otherwise truncated)'),
      },
      annotations: READ,
    },
    async ({ id, full_text }) => {
      const s = loom.sourceDetail(id);
      const cut = (t: string) => (full_text || t.length <= 400 ? t : t.slice(0, 400) + '…');
      return json({
        id: s.id,
        kind: s.kind,
        title: s.title,
        authors: s.authors,
        url: s.url,
        status: s.status,
        priority: s.priority,
        started: s.startedAt,
        finished: s.finishedAt,
        description: s.description || undefined,
        tags: s.tags,
        card_count: s.cardCount,
        notes: s.notes.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          location: n.location ?? undefined,
          quote: n.quote ?? undefined,
          body: n.body ? cut(n.body) : undefined,
        })),
        links: s.outgoing.map((l) => ({ rel: l.rel, id: l.to?.id, title: l.to?.title })),
        backlinks: s.backlinks.map((l) => ({ rel: l.rel, id: l.from.id, title: l.from.title })),
      });
    },
  );

  server.registerTool(
    'list_sources',
    {
      title: 'List sources',
      description: 'Sources / reading queue. Filter by status; "queue" sorts by priority (1 = highest).',
      inputSchema: {
        status: z.array(z.enum(SOURCE_STATUSES)).optional(),
        tag: z.string().optional(),
        sort: z.enum(['recent', 'priority', 'title']).default('recent'),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: READ,
    },
    async ({ status, tag, sort, limit }) => {
      const { items, total } = loom.sources.list({ status, tag, sort, limit });
      return json({
        total,
        sources: items.map((s) => ({ id: s.id, title: s.title, authors: s.authors, kind: s.kind, status: s.status, priority: s.priority, tags: s.tags })),
      });
    },
  );

  server.registerTool(
    'get_related',
    {
      title: 'Get related',
      description:
        'For a note or source id: its typed links and backlinks, plus semantically similar items that are not linked yet (with similarity score and whether they come from the same source).',
      inputSchema: { id: z.string(), limit: z.number().int().min(1).max(30).default(8) },
      annotations: READ,
    },
    async ({ id, limit }) => {
      const item = loom.related.findItem(id);
      if (item.type === 'card') {
        const c = loom.cards.get(id);
        return json({ card: cardForClaude(c), note: 'Cards relate through their refs; call get_related on a ref_id.' });
      }
      const r = await loom.related.related(item.type, id, limit);
      const fmt = (l: (typeof r.outgoing)[number], dir: 'out' | 'in') => {
        const o = dir === 'out' ? l.to : l.from;
        return { rel: l.rel, direction: dir, id: o?.id ?? null, title: o?.title ?? l.targetTitle, source: o?.sourceTitle ?? undefined, rationale: l.rationale ?? undefined };
      };
      return json({
        links: [...r.outgoing.map((l) => fmt(l, 'out')), ...r.backlinks.map((l) => fmt(l, 'in'))],
        similar: r.similar.map(({ alreadyLinked: _a, sourceId: _s, ...rest }) => rest),
      });
    },
  );

  server.registerTool(
    'find_connections',
    {
      title: 'Find connections',
      description:
        'Candidate CROSS-SOURCE connections for you to evaluate: for a note/source id, its nearest unlinked neighbours from other sources; ' +
        'for a topic, candidate pairs among the topic\'s notes and other sources. Similarity is only a hint; judge each pair on substance ' +
        'and propose typed links (supports/contradicts/example_of/prerequisite_of/related) or synthesis cards.',
      inputSchema: {
        id: z.string().optional().describe('Note or source id'),
        topic: z.string().optional().describe('Topic, tag or free text (when no id)'),
        limit: z.number().int().min(1).max(40).default(12),
      },
      annotations: READ,
    },
    async ({ id, topic, limit }) => {
      if (!id && !topic) throw new Error('Provide id or topic');
      let target: { type: ItemType; id: string } | { items: { type: ItemType; id: string }[] };
      if (id) {
        const item = loom.related.findItem(id);
        if (item.type === 'card') throw new Error('Use a note or source id (cards connect through their refs)');
        target = { type: item.type, id };
      } else {
        const m = await loom.topics.resolve(topic!);
        target = { items: m.items.filter((i) => i.type === 'note').concat(m.items.filter((i) => i.type === 'source')) };
      }
      const pairs = await loom.related.connections(target, limit);
      return json(
        pairs.map((p) => ({
          a: { id: p.a.id, title: p.a.title, source: p.a.sourceTitle },
          b: { id: p.b.id, type: p.b.type, kind: p.b.kind, title: p.b.title, source: p.b.sourceTitle, snippet: p.b.snippet },
          similarity: p.score,
        })),
      );
    },
  );

  server.registerTool(
    'get_study_context',
    {
      title: 'Get study context',
      description:
        'Material for a quiz or Socratic session on a topic (tag, source title or free text): relevant notes with text, sources, ' +
        'weakest cards (lowest recall probability, most lapses), recent failures with your earlier assessments, and due counts.',
      inputSchema: {
        topic: z.string().min(1),
        notes: z.number().int().min(1).max(40).default(12),
        cards: z.number().int().min(1).max(40).default(10),
      },
      annotations: READ,
    },
    async ({ topic, notes, cards }) => {
      const c = await loom.study.context(topic, { notes, cards });
      return json({ ...c, weakCards: c.weakCards.map(cardForClaude) });
    },
  );

  server.registerTool(
    'list_tags',
    { title: 'List tags', description: 'All tags (topics) with counts of notes, sources and cards.', inputSchema: {}, annotations: READ },
    async () => json(loom.tags.list()),
  );

  // ================= knowledge: write =================

  server.registerTool(
    'create_source',
    {
      title: 'Create source',
      description: 'Add a book/article/paper/video/lecture/podcast. Returns its id. Check search_knowledge first to avoid duplicates.',
      inputSchema: {
        title: z.string().min(1),
        authors: z.string().optional(),
        kind: z.enum(SOURCE_KINDS).default('book'),
        url: z.string().optional(),
        status: z.enum(SOURCE_STATUSES).default('queued'),
        priority: z.number().int().min(1).max(5).default(3).describe('1 = highest'),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      const existing = loom.sources.findByTitle(a.title);
      if (existing) return json({ id: existing.id, title: existing.title, note: 'A source with this title already exists; returned it.' });
      const s = loom.sources.create(a);
      kick();
      return json({ id: s.id, title: s.title, status: s.status });
    },
  );

  server.registerTool(
    'update_source',
    {
      title: 'Update source',
      description: 'Update a source, e.g. status (queued/reading/done/abandoned), priority, tags or description.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        authors: z.string().optional(),
        status: z.enum(SOURCE_STATUSES).optional(),
        priority: z.number().int().min(1).max(5).optional(),
        description: z.string().optional(),
        url: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    async ({ id, ...patch }) => {
      const s = loom.sources.update(id, patch);
      kick();
      return json({ id: s.id, title: s.title, status: s.status, priority: s.priority, tags: s.tags });
    },
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create note',
      description:
        'Create a note. kinds: note (general), highlight (a quote from a source; set quote + location), concept (an atomic idea), ' +
        'claim (an arguable proposition), summary. Body is Markdown; [[Title]] creates a wikilink; {{c1::text}} creates cloze cards automatically. ' +
        'Only call after the user has approved the content.',
      inputSchema: {
        title: z.string().optional().describe('Defaults to the first line/quote'),
        body: z.string().default(''),
        kind: z.enum(NOTE_KINDS).default('note'),
        source_id: z.string().optional(),
        quote: z.string().optional(),
        location: z.string().optional().describe('Page, chapter, timestamp, Kindle location'),
        tags: z.array(z.string()).optional(),
        aliases: z.array(z.string()).optional(),
        derived_from: z.array(z.string()).optional().describe('Note ids this note was extracted from; links are created automatically'),
      },
      annotations: WRITE,
    },
    async (a) => {
      const n = loom.notes.create({
        title: a.title,
        body: a.body,
        kind: a.kind,
        sourceId: a.source_id,
        quote: a.quote,
        location: a.location,
        tags: a.tags,
        aliases: a.aliases,
      });
      for (const from of a.derived_from ?? []) {
        loom.links.create({ from: { type: 'note', id: n.id }, to: { type: 'note', id: from }, rel: 'related', rationale: 'extracted from' }, 'claude');
      }
      kick();
      const d = loom.noteDetail(n.id);
      return json({
        id: n.id,
        title: n.title,
        kind: n.kind,
        source: n.sourceTitle,
        wikilinks: d.outgoing.filter((l) => l.rel === 'wikilink').map((l) => ({ title: l.targetTitle, resolved: !!l.to })),
        cloze_cards_created: d.cards.length,
      });
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update note',
      description: 'Edit a note. Use append to add text to the end of the body without rewriting it.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        body: z.string().optional().describe('Replaces the whole body'),
        append: z.string().optional().describe('Appended to the body as a new paragraph'),
        kind: z.enum(NOTE_KINDS).optional(),
        tags: z.array(z.string()).optional(),
        source_id: z.string().optional(),
        location: z.string().optional(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ id, append, source_id, ...rest }) => {
      const cur = loom.notes.get(id);
      const body = append ? `${(rest.body ?? cur.body).trimEnd()}\n\n${append}` : rest.body;
      const n = loom.notes.update(id, { ...rest, body, sourceId: source_id });
      kick();
      return json({ id: n.id, title: n.title, updated_at: n.updatedAt });
    },
  );

  server.registerTool(
    'create_card',
    {
      title: 'Create card',
      description:
        'Create a spaced-repetition card. Types: basic (front question, back answer), cloze (front with {{c1::hidden}} deletions; one card per index), ' +
        'open (open-ended prompt graded by you against back/rubric), synthesis (question combining ideas from 2+ DIFFERENT sources; refs must span 2+ sources; include a rubric). ' +
        'Always pass refs to the notes/sources the card comes from. Only call after the user approves.',
      inputSchema: {
        type: z.enum(CARD_TYPES),
        front: z.string().min(1),
        back: z.string().optional().describe('Answer (required for basic), or model answer/extra context'),
        rubric: z.string().optional().describe('What a good answer must contain (open/synthesis)'),
        refs: z.array(refSchema).default([]).describe('Notes/sources this card tests'),
        tags: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      const cards = loom.cards.create(schemas.CardCreate.parse(a), 'claude');
      return json(cards.map((c) => ({ id: c.id, type: c.type, prompt: c.prompt, from: c.refs.map((r) => r.title) })));
    },
  );

  server.registerTool(
    'update_card',
    {
      title: 'Update card',
      description: 'Rewrite a card (front/back/rubric), retag it, or suspend it. Scheduling is kept unless reset=true.',
      inputSchema: {
        card_id: z.string(),
        front: z.string().optional(),
        back: z.string().optional(),
        rubric: z.string().optional(),
        suspended: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        reset: z.boolean().default(false).describe('Reset to new (use after substantially changing what the card asks)'),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ card_id, reset, ...patch }) => {
      let c = loom.cards.update(card_id, patch);
      if (reset) c = loom.review.forget(card_id);
      return json(cardForClaude(c));
    },
  );

  server.registerTool(
    'create_link',
    {
      title: 'Create link',
      description:
        'Create a typed, directed link between notes/sources: A supports B, A contradicts B, A example_of B, A prerequisite_of B, or related. ' +
        'Include a one-sentence rationale naming the specific claims. Only call after the user approves.',
      inputSchema: {
        from_id: z.string(),
        to_id: z.string(),
        rel: z.enum(TYPED_LINK_RELS),
        rationale: z.string().optional(),
      },
      annotations: WRITE,
    },
    async ({ from_id, to_id, rel, rationale }) => {
      const f = loom.related.findItem(from_id);
      const t = loom.related.findItem(to_id);
      if (f.type === 'card' || t.type === 'card') throw new Error('Links connect notes and sources, not cards');
      const l = loom.links.create({ from: { type: f.type, id: from_id }, to: { type: t.type, id: to_id }, rel, rationale }, 'claude');
      return json({ link_id: l.id, from: l.from.title, rel: l.rel, to: l.to?.title, rationale: l.rationale });
    },
  );
}
