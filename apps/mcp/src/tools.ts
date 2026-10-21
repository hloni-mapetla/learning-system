import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  REVIEW_TASK_ID,
  TASK_KINDS,
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
  type Session,
  type Day,
  type Subtask,
  type SubtaskResult,
  type Task,
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
        created_by: n.createdBy,
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
      description:
        'A source (book/article/paper/video/lecture) with metadata, its highlights and notes, links and card count. ' +
        'If recall_state is "none", the learner has not done a blank-page recall yet: do NOT show, quote or summarise the highlights; ' +
        'ask for the recall first (start_recall / save_recall).',
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
        method: s.method,
        recall_state: s.recallState,
        card_count: s.cardCount,
        notes: s.notes.map((n) => ({
          id: n.id,
          kind: n.kind,
          created_by: n.createdBy,
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

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        "Browse notes, newest first. scope=standalone for the learner's own notes not tied to any source (their second brain), " +
        'scope=sourced for notes on books/articles. Filter by kind, tag, or since (YYYY-MM-DD). Use get_note for full text.',
      inputSchema: {
        scope: z.enum(['all', 'standalone', 'sourced']).default('all'),
        kinds: z.array(z.enum(NOTE_KINDS)).optional(),
        tag: z.string().optional(),
        since: z.string().optional().describe('YYYY-MM-DD or ISO timestamp'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ,
    },
    async ({ scope, kinds, tag, since, limit }) => {
      const { items, total } = loom.notes.list({ scope: scope === 'all' ? undefined : scope, kind: kinds, tag, since, limit });
      return json({
        total,
        notes: items.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          source: n.sourceTitle ?? undefined,
          created_by: n.createdBy,
          tags: n.tags.length ? n.tags : undefined,
          preview: (n.body || n.quote || '').slice(0, 160) || undefined,
          updated_at: n.updatedAt,
        })),
      });
    },
  );

  // ================= knowledge: write =================

  server.registerTool(
    'append_to_daily_note',
    {
      title: 'Append to daily note',
      description:
        "Jot a thought into the learner's daily note (one standalone note per day, created on first use, titled YYYY-MM-DD), " +
        'stamped with the time. Use when they say "note this", "remember that…", "add to my journal". Save their words, not your paraphrase.',
      inputSchema: {
        text: z.string().min(1).describe("The learner's thought, in their words"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Defaults to today (local)'),
      },
      annotations: WRITE,
    },
    async ({ text, date }) => {
      const n = loom.notes.appendDaily(text, { date });
      kick();
      return json({ id: n.id, title: n.title, chars: n.body.length });
    },
  );

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
      const s = loom.sources.create(a, 'claude');
      kick();
      return json({ id: s.id, title: s.title, status: s.status, recall_state: loom.processing.stateOf(s.id) });
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
        'Create a note. Omit source_id for a standalone note (the learner\'s own ideas, not tied to any book). kinds: note (general), highlight (a quote from a source; set quote + location), concept (an atomic idea), ' +
        'claim (an arguable proposition), summary, explanation (the learner explaining a concept in their own words). ' +
        'Body is Markdown; [[Title]] creates a wikilink; {{c1::text}} creates cloze cards automatically. ' +
        'authored_by: "user" ONLY when saving the learner\'s own words (verbatim; fixing typos is fine), "claude" for anything you drafted ' +
        '(it is shown as written by Claude). Use save_recall for blank-page recalls. Only call after the user has approved the content.',
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
        authored_by: z.enum(['user', 'claude']).default('claude').describe('Who wrote the text: user = the learner\'s own words'),
      },
      annotations: WRITE,
    },
    async (a) => {
      if (a.kind === 'recall') throw new Error('Use save_recall for blank-page recalls (it also records the processing method).');
      const n = loom.notes.create({
        title: a.title,
        body: a.body,
        kind: a.kind,
        sourceId: a.source_id,
        quote: a.quote,
        location: a.location,
        tags: a.tags,
        aliases: a.aliases,
      }, a.authored_by);
      for (const from of a.derived_from ?? []) {
        loom.links.create({ from: { type: 'note', id: n.id }, to: { type: 'note', id: from }, rel: 'related', rationale: 'extracted from' }, 'claude');
      }
      kick();
      const d = loom.noteDetail(n.id);
      return json({
        id: n.id,
        title: n.title,
        kind: n.kind,
        authored_by: n.createdBy,
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

  // ================= processing: recall first =================

  server.registerTool(
    'start_recall',
    {
      title: 'Start recall',
      description:
        'Begin processing a source the generation-first way. Returns whether a blank-page recall exists (recall_state), how many ' +
        'highlights there are (count only, no text) and the recall prompt to give the learner. If recall_state is "none", ask for the ' +
        'recall before showing anything from the source.',
      inputSchema: { source_id: z.string() },
      annotations: READ,
    },
    async ({ source_id }) => {
      const s = loom.processing.status(source_id);
      return json({
        source: s.source,
        recall_state: s.state,
        highlight_count: s.highlightCount,
        recalls: s.recalls,
        prompt_for_learner: s.prompt,
        expectation: s.note,
      });
    },
  );

  server.registerTool(
    'save_recall',
    {
      title: 'Save recall',
      description:
        "Save the learner's blank-page recall of a source VERBATIM (their words, not yours; don't tidy or complete it). " +
        'Stored as a recall note by the user. The first recall on an unprocessed source marks it recall_first. Then call get_recall_review.',
      inputSchema: { source_id: z.string(), text: z.string().min(1).describe("The learner's recall, exactly as they wrote it") },
      annotations: WRITE,
    },
    async ({ source_id, text }) => {
      const n = loom.processing.saveRecall(source_id, text);
      kick();
      const s = loom.sources.get(source_id);
      return json({ recall_note_id: n.id, source: s.title, method: s.method, next: 'Call get_recall_review to compare against the highlights.' });
    },
  );

  server.registerTool(
    'skip_recall',
    {
      title: 'Skip recall',
      description:
        'Only when the learner explicitly declines a recall: marks the source as processed highlights-first (kept separate in their ' +
        'recall-first vs highlights-first experiment) and unhides its highlights in the UI.',
      inputSchema: { source_id: z.string() },
      annotations: WRITE,
    },
    async ({ source_id }) => {
      const s = loom.processing.skipRecall(source_id);
      return json({ source: s.source, recall_state: s.state });
    },
  );

  server.registerTool(
    'get_recall_review',
    {
      title: 'Get recall review',
      description:
        "The learner's recall(s) for a source next to its highlights, for you to report what they MISSED and what they got WRONG " +
        '(each tied to a highlight). Each highlight has a similarity hint to the nearest recalled fragment (low = likely missed; ' +
        'judge for yourself). Misses are the best card candidates. Also returns the learner\'s own notes on the source to critique. ' +
        'Next, ask the learner to draft the concept/claim notes in their own words; critique their drafts rather than writing notes for them.',
      inputSchema: { source_id: z.string() },
      annotations: READ,
    },
    async ({ source_id }) => {
      const c = await loom.processing.compare(source_id);
      return json({
        source: c.source,
        recalls: c.recalls,
        highlights: c.highlights.map((h) => ({
          id: h.id,
          quote: h.quote,
          comment: h.comment ?? undefined,
          location: h.location ?? undefined,
          similarity: h.similarity,
          nearest_recalled: h.nearestFragment ?? undefined,
        })),
        own_notes: c.ownNotes,
        notes_by_claude: c.claudeNotes,
        misses_are_card_candidates: true,
      });
    },
  );

  // ================= tasks =================

  const stepOut = (st: Subtask) => ({ id: st.id, title: st.title, done: st.done, ...(st.createdBy !== 'user' ? { by: st.createdBy } : {}) });
  const taskOut = (t: Task, full = false) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    due: t.dueDate,
    priority: t.priority,
    status: t.status,
    source: t.sourceTitle ?? undefined,
    source_id: t.sourceId ?? undefined,
    details: t.details || undefined,
    ...(t.progress.total ? { progress: `${t.progress.done}/${t.progress.total}` } : {}),
    ...(t.nextAction ? { next_action: { id: t.nextAction.id, title: t.nextAction.title } } : {}),
    ...(t.needsFirstStep ? { needs_first_step: true } : {}),
    ...(t.singleStep && !t.virtual ? { single_step: true } : {}),
    ...(t.progress.total && (full || t.status === 'open') ? { steps: t.subtasks.map(stepOut) } : {}),
    ...(t.createdBy !== 'user' && !t.virtual ? { created_by: t.createdBy } : {}),
    ...(full ? { completed_at: t.completedAt ?? undefined, created_at: t.createdAt } : {}),
    ...(t.virtual ? { virtual: true } : {}),
  });
  const stepResult = (r: SubtaskResult) => ({
    step: stepOut(r.subtask),
    task: taskOut(r.task),
    ...(r.allStepsDone
      ? { all_steps_done: true, message: 'All steps done. Ask the user whether to complete the task (complete_task); never complete it on your own.' }
      : {}),
  });

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        "The user's to-do list. view=today (overdue + due today + urgent, plus a computed 'Review N due cards' task), upcoming, all_open, done. " +
        'view=reading_queue returns sources being read/queued by priority with their open tasks. Each task has its steps, progress ("2/5"), ' +
        'next_action (the first unfinished step: talk about this, not the vague task title) and needs_first_step when no concrete step is written yet.',
      inputSchema: {
        view: z.enum(['today', 'upcoming', 'all_open', 'done', 'reading_queue']).default('today'),
        source_id: z.string().optional(),
      },
      annotations: READ,
    },
    async ({ view, source_id }) => {
      if (view === 'reading_queue') return json(loom.tasks.readingQueue());
      return json(loom.tasks.list({ view, sourceId: source_id, limit: 100 }).map((t) => taskOut(t)));
    },
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Add a to-do. kinds: todo, read ("read chapter 4"), process_highlights, summarize ("write summary of X"), write. ' +
        'Link learning tasks to a source_id. due is YYYY-MM-DD (local). priority 1 = highest. single_step: true for tasks too small to need steps. ' +
        'authored_by "user" when the task is the user\'s own words ("add a task: …"), else "claude". Add steps with add_subtask.',
      inputSchema: {
        title: z.string().min(1),
        kind: z.enum(TASK_KINDS).default('todo'),
        source_id: z.string().optional(),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        priority: z.number().int().min(1).max(5).default(3),
        details: z.string().optional(),
        single_step: z.boolean().optional(),
        authored_by: z.enum(['claude', 'user']).default('claude'),
      },
      annotations: WRITE,
    },
    async (a) =>
      json(
        taskOut(
          loom.tasks.create(
            { title: a.title, kind: a.kind, sourceId: a.source_id, dueDate: a.due, priority: a.priority, details: a.details, singleStep: a.single_step },
            a.authored_by,
          ),
        ),
      ),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task',
      description:
        'Mark a task done. For reading tasks the result includes a follow_up (blank_page_recall): ask the learner what they remember ' +
        'BEFORE looking at highlights, and save it with save_recall.',
      inputSchema: { task_id: z.string() },
      annotations: WRITE,
    },
    async ({ task_id }) => {
      if (task_id === REVIEW_TASK_ID) {
        return json({ error: "The review task completes itself when today's due cards are reviewed. Use get_due_cards to review." });
      }
      const r = loom.tasks.complete(task_id, 'claude');
      return json({ task: taskOut(r.task), follow_up: r.followUp });
    },
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description:
        'Change a task: title, due date, priority, details, single_step, or status (open/cancelled; use complete_task to finish). ' +
        'Moving a dated task is logged (so the weekly review can see tasks that keep getting moved).',
      inputSchema: {
        task_id: z.string(),
        title: z.string().optional(),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        priority: z.number().int().min(1).max(5).optional(),
        details: z.string().optional(),
        single_step: z.boolean().optional(),
        status: z.enum(['open', 'cancelled']).optional(),
      },
      annotations: WRITE,
    },
    async ({ task_id, due, single_step, ...patch }) =>
      json(taskOut(loom.tasks.update(task_id, { ...patch, dueDate: due, singleStep: single_step }, 'claude'))),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'One task with all its steps (done and not), progress, next_action and needs_first_step.',
      inputSchema: { task_id: z.string() },
      annotations: READ,
    },
    async ({ task_id }) => {
      if (task_id === REVIEW_TASK_ID) {
        const rt = loom.tasks.reviewTask();
        return json(rt ? taskOut(rt, true) : { error: 'No cards are due, so there is no review task right now.' });
      }
      return json(taskOut(loom.tasks.get(task_id), true));
    },
  );

  // ================= steps (subtasks) =================

  server.registerTool(
    'add_subtask',
    {
      title: 'Add steps to a task',
      description:
        "Add one or more ordered steps to a task (appended, or inserted at position; 0 = first). The first unfinished step is the task's next action. " +
        'Steps should be concrete physical actions startable in ~2 minutes ("open the draft and reread §2.3", not "work on thesis"). ' +
        'The learner drafts steps first; save their wording with authored_by "user". Steps you drafted (only when they said "suggest for me") are authored_by "claude". ' +
        'The result lists vague-looking steps under hints; mention them gently, never block.',
      inputSchema: {
        task_id: z.string(),
        steps: z.array(z.string().min(1)).min(1),
        position: z.number().int().min(0).optional(),
        authored_by: z.enum(['claude', 'user']).default('claude'),
      },
      annotations: WRITE,
    },
    async ({ task_id, steps, position, authored_by }) => {
      const r = loom.subtasks.add(task_id, steps, { position, createdBy: authored_by });
      return json({
        task: taskOut(r.task),
        added: r.added.map(stepOut),
        ...(r.hints.length ? { hints: r.hints.map((h) => ({ step: h.title, hint: h.hint })) } : {}),
        ...(r.stepsDefined ? { steps_defined: true } : {}),
      });
    },
  );

  server.registerTool(
    'update_subtask',
    {
      title: 'Update step',
      description: 'Reword a step, or mark it done/not done.',
      inputSchema: { subtask_id: z.string(), title: z.string().min(1).optional(), done: z.boolean().optional() },
      annotations: WRITE,
    },
    async ({ subtask_id, ...patch }) => json(stepResult(loom.subtasks.update(subtask_id, patch, 'claude'))),
  );

  server.registerTool(
    'complete_subtask',
    {
      title: 'Complete step',
      description:
        'Tick off a step (undo: true to untick). Returns the new next_action. When every step is done the result says all_steps_done: ' +
        'ask the user whether to complete the task; never complete it on your own.',
      inputSchema: { subtask_id: z.string(), undo: z.boolean().default(false) },
      annotations: WRITE,
    },
    async ({ subtask_id, undo }) =>
      json(stepResult(undo ? loom.subtasks.uncomplete(subtask_id, 'claude') : loom.subtasks.complete(subtask_id, 'claude'))),
  );

  server.registerTool(
    'reorder_subtasks',
    {
      title: 'Reorder steps',
      description: "Set the order of a task's steps. subtask_ids must list every step of the task exactly once (get_task shows them).",
      inputSchema: { task_id: z.string(), subtask_ids: z.array(z.string()).min(1) },
      annotations: WRITE,
    },
    async ({ task_id, subtask_ids }) => json(taskOut(loom.subtasks.reorder(task_id, subtask_ids), true)),
  );

  server.registerTool(
    'delete_subtask',
    {
      title: 'Delete step',
      description: 'Remove a step from a task (e.g. one saved by mistake). Only after the user agrees.',
      inputSchema: { subtask_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ subtask_id }) => json(taskOut(loom.subtasks.remove(subtask_id), true)),
  );

  // ================= sessions (starter / focus) =================

  const sessionOut = (x: Session) => ({
    id: x.id,
    kind: x.kind,
    task: x.taskTitle ?? undefined,
    task_id: x.taskId ?? undefined,
    step: x.subtaskTitle ?? undefined,
    step_id: x.subtaskId ?? undefined,
    planned_minutes: x.plannedMinutes,
    started_at: x.startedAt,
    ends_at: x.endsAt,
    ...(x.endedAt ? { ended_at: x.endedAt, actual_minutes: x.actualMinutes, outcome: x.outcome } : { running: true }),
    ...(x.subtasksCompleted.length ? { steps_completed: x.subtasksCompleted.map((s) => s.title) } : {}),
    ...(x.continuedFrom ? { continued_from: x.continuedFrom } : {}),
    ...(x.createdBy !== 'user' ? { created_by: x.createdBy } : {}),
  });

  server.registerTool(
    'start_session',
    {
      title: 'Start a work session',
      description:
        'Start a timed session in Loom (the timer shows in the web UI). kind "starter" = "just 10 minutes" to get past starting ' +
        '(length from settings); kind "focus" = a full focus block followed by a real break. Attach it to a task_id and/or the step ' +
        '(subtask_id, usually the next_action). Only one session runs at a time. Offer it; start it only when the user says yes.',
      inputSchema: {
        kind: z.enum(['starter', 'focus']).default('starter'),
        task_id: z.string().optional(),
        subtask_id: z.string().optional(),
        minutes: z.number().positive().max(240).optional(),
      },
      annotations: WRITE,
    },
    async (a) => json(sessionOut(loom.sessions.start({ kind: a.kind, taskId: a.task_id, subtaskId: a.subtask_id, minutes: a.minutes }, 'claude'))),
  );

  server.registerTool(
    'end_session',
    {
      title: 'End a work session',
      description:
        'End the running session. Its outcome follows the clock: "completed" if the planned time ran out, else "stopped" (stopping a starter ' +
        'early still counts). keep_going: true rolls a starter into a full focus block on the same work. abandon: true only if the user says ' +
        'it should not count.',
      inputSchema: { session_id: z.string(), keep_going: z.boolean().default(false), abandon: z.boolean().default(false) },
      annotations: WRITE,
    },
    async ({ session_id, keep_going, abandon }) => {
      if (keep_going) {
        const next = loom.sessions.keepGoing(session_id, 'claude');
        return json({ ended: sessionOut(loom.sessions.get(session_id)), started: sessionOut(next) });
      }
      return json(sessionOut(loom.sessions.end(session_id, { outcome: abandon ? 'abandoned' : undefined })));
    },
  );

  server.registerTool(
    'get_sessions',
    {
      title: 'Get work sessions',
      description:
        'The live timer (running session, or a break after a focus block) and the session log: starter sessions and focus blocks with ' +
        'planned vs actual minutes, outcome and steps completed. from/to are ISO dates or timestamps (default: the last 7 days).',
      inputSchema: { from: z.string().optional(), to: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) },
      annotations: READ,
    },
    async ({ from, to, limit }) => {
      const st = loom.sessions.state();
      const since = from ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
      return json({
        running: st.running ? sessionOut(st.running) : null,
        on_break_until: st.onBreak?.until ?? null,
        sessions: loom.sessions.list({ from: since, to, limit }).map(sessionOut),
      });
    },
  );

  server.registerTool(
    'park_thought',
    {
      title: 'Park a distracting thought',
      description:
        'Parking lot: during a focus block, save a distracting thought ("check that email") under "Parked" in today\'s daily note so the user ' +
        "can deal with it after the block, without acting on it now. Save their words.",
      inputSchema: { text: z.string().min(1) },
      annotations: WRITE,
    },
    async ({ text }) => {
      const n = loom.sessions.park(text);
      kick();
      return json({ parked: text, daily_note: n.title, daily_note_id: n.id });
    },
  );

  // ================= days: evening plan and morning =================

  const hm = (iso: string | null) => (iso ? new Date(iso).toTimeString().slice(0, 5) : null);
  const dayOut = (d: Day) => ({
    date: d.date,
    woke_at: hm(d.wakeAt),
    work_started_at: hm(d.workStartAt),
    ...(d.wakeToWorkMinutes !== null ? { wake_to_work_minutes: d.wakeToWorkMinutes } : {}),
    first_thing: d.firstThing
      ? {
          task: d.firstThing.task.title,
          task_id: d.firstThing.task.id,
          ...(d.firstThing.task.status !== 'open' ? { task_status: d.firstThing.task.status } : {}),
          step: d.firstThing.step?.title ?? null,
          step_id: d.firstThing.step?.id ?? null,
        }
      : null,
    target_start: d.targetStart,
    ...(d.plannedAt ? { planned_at: d.plannedAt, planned_by: d.plannedBy } : {}),
    ...(d.shutdownAt ? { shutdown_at: hm(d.shutdownAt) } : {}),
    routine: d.routine.map((i) => ({ id: i.id, item: i.title, ...(i.optional ? { optional: true } : {}), done: !!i.checkedAt })),
  });
  const daySpec = z.string().default('today').describe('today, tomorrow, yesterday or YYYY-MM-DD (the day rolls over at 4am)');

  server.registerTool(
    'get_day',
    {
      title: 'Get a day',
      description:
        "A day in Loom: when the user woke and started work, the first thing planned for it (task and concrete first step), the target " +
        'start time, the morning routine with what is ticked, and the shutdown. date=tomorrow shows the plan made tonight. ' +
        "include_done adds what got done that day (today only).",
      inputSchema: { date: daySpec, include_done: z.boolean().default(false) },
      annotations: READ,
    },
    async ({ date, include_done }) => {
      const d = loom.days.get(date);
      return json({ ...dayOut(d), ...(include_done && d.date === loom.days.get('today').date ? { done: loom.tasks.doneToday() } : {}) });
    },
  );

  server.registerTool(
    'set_first_task',
    {
      title: 'Set the first task for a day',
      description:
        'Decide the night before: set the ONE task to start with (default tomorrow) and its first physical step. Pass subtask_id for one of ' +
        "its open steps, or step_title for a new first step in the user's words (authored_by user), or neither to use its next_action. " +
        "A task with no steps needs step_title (or single_step). target_start is optional (\"08:30\"). Returns a soft hint if the step is vague. " +
        'Set it only once the user has chosen. clear: true removes the plan.',
      inputSchema: {
        date: daySpec.default('tomorrow'),
        task_id: z.string().optional(),
        subtask_id: z.string().optional(),
        step_title: z.string().optional(),
        target_start: z.string().nullish(),
        authored_by: z.enum(['user', 'claude']).default('user').describe('Who wrote step_title'),
        clear: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    async (a) => {
      if (a.clear) return json(dayOut(loom.days.clearPlan(a.date)));
      if (!a.task_id) throw new Error('task_id is required');
      const { day, hint } = loom.days.plan(
        a.date,
        { taskId: a.task_id, subtaskId: a.subtask_id, stepTitle: a.step_title, targetStart: a.target_start, stepBy: a.authored_by },
        'claude',
      );
      return json({ ...dayOut(day), ...(hint ? { hint } : {}) });
    },
  );

  server.registerTool(
    'log_wake',
    {
      title: 'Log the wake time',
      description: 'Record when the user got up (default now; at = "07:10" to correct it, or clear: true). Also ticks "Stand up" in the routine.',
      inputSchema: { date: daySpec, at: z.string().optional(), clear: z.boolean().default(false) },
      annotations: WRITE,
    },
    async ({ date, at, clear }) => json(dayOut(loom.days.logWake(date, clear ? null : (at ?? new Date())))),
  );

  // ================= import & stats =================

  server.registerTool(
    'import_highlights',
    {
      title: 'Import highlights',
      description:
        'Bulk-import highlights. format=kindle for the contents of a Kindle "My Clippings.txt" (creates a source per book; re-imports are skipped); ' +
        'format=plain for blank-line-separated quotes, optionally ending in "(p. 12)" / "loc 340", with "Note: ..." lines attached to the previous quote. ' +
        'Returns counts and note ids. If the source has no recall yet, do not show or discuss the highlight text: ask for a blank-page recall first.',
      inputSchema: {
        text: z.string().min(1),
        format: z.enum(['auto', 'kindle', 'plain']).default('auto'),
        source_id: z.string().optional(),
        source_title: z.string().optional().describe('Creates the source if needed (plain format)'),
        authors: z.string().optional(),
        books: z.array(z.string()).optional().describe('Kindle: only import books whose title contains one of these'),
      },
      annotations: WRITE,
    },
    async (a) => {
      const kindle = a.format === 'kindle' || (a.format === 'auto' && /^={10}\s*$/m.test(a.text) && /Your (Highlight|Note)/i.test(a.text));
      const r = kindle
        ? loom.importer.kindle(a.text, { onlyBooks: a.books })
        : loom.importer.pasted(a.text, { sourceId: a.source_id, sourceTitle: a.source_title, authors: a.authors });
      kick();
      return json({
        format: kindle ? 'kindle' : 'plain',
        ...r,
        sources: r.sources.map((s) => ({ ...s, recall_state: loom.processing.stateOf(s.id) })),
      });
    },
  );

  server.registerTool(
    'get_review_stats',
    {
      title: 'Get review stats',
      description:
        'Learning analytics: retention (share of review answers not rated Again) over 7/30/90 days, 30-day due forecast, streak, ' +
        'card counts by state, weakest topics and per-source mastery (mean probability of recall now; new cards count as 0).',
      inputSchema: { top: z.number().int().min(1).max(50).default(8).describe('How many weakest topics/sources to return') },
      annotations: READ,
    },
    async ({ top }) => {
      const s = loom.stats.compute();
      const fmt = (m: (typeof s.topics)[number]) => ({
        name: m.name,
        ...(m.id ? { id: m.id } : {}),
        cards: m.cards,
        reviewed: m.reviewed,
        mastery: pct(m.mastery),
        retention_90d: pct(m.retention),
        lapses: m.lapses,
        due: m.due,
      });
      return json({
        totals: s.totals,
        retention: s.retention.map((r) => ({ days: r.days, reviews: r.reviews, rate: pct(r.rate) })),
        streak_days: s.streak,
        reviewed_today: s.reviewedToday,
        forecast_next_7_days: s.forecast.slice(0, 7),
        forecast_30_day_total: s.forecast.reduce((a, d) => a + d.count, 0),
        weakest_topics: s.topics.slice(0, top).map(fmt),
        weakest_sources: s.sources.slice(0, top).map(fmt),
      });
    },
  );
}
