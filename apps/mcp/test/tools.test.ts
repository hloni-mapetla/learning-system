import { describe, expect, it, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/index.ts';
import { testLoom } from '../../../packages/core/test/helpers.ts';
import { localDate } from '@loom/core';

type Loom = ReturnType<typeof testLoom>;

async function connect(loom: Loom) {
  const server = createMcpServer(loom);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  return { client, call };
}

let loom: Loom;
let call: Awaited<ReturnType<typeof connect>>['call'];
let client: Client;
let ids: Record<string, string>;

beforeEach(async () => {
  loom = testLoom();
  ({ call, client } = await connect(loom));
  const kahneman = loom.sources.create({ title: 'Thinking, Fast and Slow', authors: 'Daniel Kahneman', tags: ['psychology'] });
  const tetlock = loom.sources.create({ title: 'Superforecasting', authors: 'Philip Tetlock', tags: ['forecasting'] });
  const ease = loom.notes.create({
    title: 'Cognitive ease',
    kind: 'concept',
    sourceId: kahneman.id,
    body: 'Fluent processing feels like {{c1::truth}}. Repetition breeds familiarity which breeds belief.',
  });
  const outside = loom.notes.create({
    title: 'Outside view',
    kind: 'claim',
    sourceId: tetlock.id,
    body: 'Forecasters should start from base rates; fluent stories breed overconfident belief.',
  });
  ids = { kahneman: kahneman.id, tetlock: tetlock.id, ease: ease.id, outside: outside.id };
});

describe('MCP server', () => {
  it('lists tools with annotations and the four session prompts', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['get_due_cards', 'record_review', 'search_knowledge', 'get_note', 'get_source', 'get_related', 'create_note', 'create_card', 'create_link', 'find_connections', 'get_study_context']) {
      expect(names).toContain(n);
    }
    expect(tools.find((t) => t.name === 'get_due_cards')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'create_card')!.annotations?.readOnlyHint).toBe(false);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['connect', 'daily_review', 'exam_prep', 'process_reading']);
    const p = await client.getPrompt({ name: 'exam_prep', arguments: { topic: 'heuristics' } });
    expect((p.messages[0].content as { text: string }).text).toContain('get_study_context("heuristics")');
    expect(client.getInstructions()).toContain('never reveal');
  });

  it('runs a review loop: due cards → record (claude grader) → rescheduled → undo', async () => {
    const due = await call('get_due_cards', { limit: 5 });
    expect(due.due_today.total).toBe(1);
    const card = due.cards[0];
    expect(card).toMatchObject({ type: 'cloze', prompt: 'Fluent processing feels like [...]. Repetition breeds familiarity which breeds belief.', hidden: ['truth'], state: 'new' });
    expect(card.from[0]).toBe('Cognitive ease (Thinking, Fast and Slow)');

    const r = await call('record_review', { card_id: card.id, rating: 'good', notes: 'Correct, a little slow' });
    expect(r).toMatchObject({ rating: 'good', state: 'learning', next_review_in: '10 min' });
    expect(loom.review.history(card.id)[0]).toMatchObject({ grader: 'claude', notes: 'Correct, a little slow' });

    await call('undo_review', { card_id: card.id });
    expect(loom.cards.get(card.id).state).toBe('new');
    await expect(call('record_review', { card_id: card.id, rating: 'perfect' })).rejects.toThrow();
  });

  it('filters due cards by topic (tag on the source)', async () => {
    loom.cards.create({ type: 'basic', front: 'Start forecasts from?', back: 'Base rates', refs: [{ type: 'note', id: ids.outside }] });
    const due = await call('get_due_cards', { topic: 'forecasting' });
    expect(due.topic_matched_by).toBe('tag');
    expect(due.cards.map((c: any) => c.prompt)).toEqual(['Start forecasts from?']);
  });

  it('searches, gets notes/sources, and finds cross-source connections', async () => {
    const hits = await call('search_knowledge', { query: 'familiarity belief' });
    expect(hits[0]).toMatchObject({ id: ids.ease, source: 'Thinking, Fast and Slow' });
    const note = await call('get_note', { id: ids.ease });
    expect(note.cards).toHaveLength(1);
    const src = await call('get_source', { id: ids.tetlock });
    expect(src.notes.map((n: any) => n.title)).toEqual(['Outside view']);

    const conns = await call('find_connections', { id: ids.ease });
    expect(conns[0].b).toMatchObject({ id: ids.outside, source: 'Superforecasting' });
    const rel = await call('get_related', { id: ids.ease });
    expect(rel.similar.map((s: any) => s.id)).toContain(ids.outside);
  });

  it('creates notes, cards and links as Claude, enforcing synthesis rules', async () => {
    const n = await call('create_note', {
      title: 'Fluency and forecasting',
      kind: 'claim',
      body: 'Links [[Cognitive ease]] to [[Outside view]].',
      derived_from: [ids.ease],
    });
    expect(n.wikilinks).toEqual([{ title: 'Cognitive ease', resolved: true }, { title: 'Outside view', resolved: true }]);

    await expect(
      call('create_card', { type: 'synthesis', front: 'Q', refs: [{ type: 'note', id: ids.ease }] }),
    ).rejects.toThrow(/two different sources/);
    const [syn] = await call('create_card', {
      type: 'synthesis',
      front: 'How does cognitive ease explain why forecasters need the outside view?',
      rubric: 'Fluent narratives feel true → overconfidence; base rates correct it.',
      refs: [{ type: 'note', id: ids.ease }, { type: 'note', id: ids.outside }],
    });
    expect(loom.cards.get(syn.id)).toMatchObject({ createdBy: 'claude', type: 'synthesis' });
    expect(loom.notes.get(n.id).createdBy).toBe('claude'); // Claude's drafts are marked as Claude's by default

    const link = await call('create_link', { from_id: ids.ease, to_id: ids.outside, rel: 'supports', rationale: 'Fluency-driven belief is why the inside view misleads' });
    expect(link).toMatchObject({ from: 'Cognitive ease', rel: 'supports', to: 'Outside view' });
    // Already linked → excluded from connection candidates.
    const conns = await call('find_connections', { id: ids.ease });
    expect(conns.map((c: any) => c.b.id)).not.toContain(ids.outside);
  });

  it('returns study context for a topic', async () => {
    const card = loom.cards.list({ noteId: ids.ease }).items[0];
    loom.review.record(card.id, 'again', { grader: 'claude', notes: 'said "beauty"' });
    const ctx = await call('get_study_context', { topic: 'psychology' });
    expect(ctx).toMatchObject({ matchedBy: 'tag', totalCards: 1 });
    expect(ctx.notes.map((n: any) => n.title)).toContain('Cognitive ease');
    expect(ctx.weakCards[0].id).toBe(card.id);
    expect(ctx.recentLapses[0].notes).toBe('said "beauty"');
  });

  it('dedupes create_source and updates status', async () => {
    const again = await call('create_source', { title: 'superforecasting' });
    expect(again.id).toBe(ids.tetlock);
    const up = await call('update_source', { id: ids.tetlock, status: 'done' });
    expect(up.status).toBe('done');
    expect(loom.sources.get(ids.tetlock).finishedAt).toBeTruthy();
  });
});

describe('MCP task tools', () => {
  it('lists today with the review task, completes reading tasks with a recall follow-up', async () => {
    const t = await call('create_task', { title: 'Read ch. 4', kind: 'read', source_id: ids.tetlock, due: localDate() });
    const today = await call('list_tasks', { view: 'today' });
    expect(today[0]).toMatchObject({ id: 'review-today', virtual: true });
    expect(today.map((x: any) => x.title)).toContain('Read ch. 4');
    const done = await call('complete_task', { task_id: t.id });
    expect(done.follow_up).toMatchObject({ action: 'blank_page_recall', sourceTitle: 'Superforecasting' });
    expect((await call('complete_task', { task_id: 'review-today' })).error).toMatch(/completes itself/);
    const queue = await call('list_tasks', { view: 'reading_queue' });
    expect(queue.map((s: any) => s.title)).toContain('Superforecasting');
  });
});

describe('MCP import & stats tools', () => {
  it('imports plain highlights into a new source and reports stats', async () => {
    const r = await call('import_highlights', { text: 'Premature optimization is the root of all evil. (p. 268)\n\nNote: Knuth', source_title: 'Structured Programming with go to', authors: 'Donald Knuth' });
    expect(r).toMatchObject({ format: 'plain', created: 1 });
    const n = await call('get_note', { id: r.noteIds[0] });
    expect(n).toMatchObject({ kind: 'highlight', location: 'p. 268', body: 'Knuth' });

    const k = await call('import_highlights', { text: 'Book (Ann Author)\n- Your Highlight on page 1 | Location 5-6 | Added on Monday\n\nHello world\n==========\n' });
    expect(k).toMatchObject({ format: 'kindle', created: 1, sources: [{ title: 'Book', created: true }] });

    const card = loom.cards.list({ noteId: ids.ease }).items[0];
    loom.review.record(card.id, 'good', { grader: 'claude' });
    const s = await call('get_review_stats', {});
    expect(s.reviewed_today).toBe(1);
    expect(s.weakest_sources[0]).toMatchObject({ name: 'Thinking, Fast and Slow', cards: 1 });
    expect(s.forecast_next_7_days).toHaveLength(7);
  });
});

describe('MCP recall-first processing', () => {
  it('runs recall → compare → learner-authored notes, without leaking highlights before the recall', async () => {
    await call('import_highlights', {
      text: 'Fluent stories feel true even when they are not.\n\nBase rates beat vivid anecdotes.\n\nForecasts improve with frequent small updates.',
      source_id: ids.tetlock,
    });
    const start = await call('start_recall', { source_id: ids.tetlock });
    expect(start).toMatchObject({ recall_state: 'none', highlight_count: 3 });
    expect(start.prompt_for_learner).toMatch(/what do you remember/i);
    expect(JSON.stringify(start)).not.toContain('anecdotes');
    expect((await call('get_source', { id: ids.tetlock })).recall_state).toBe('none');

    const saved = await call('save_recall', { source_id: ids.tetlock, text: 'Start from base rates, not vivid anecdotes. Update often.' });
    expect(saved.method).toBe('recall_first');
    expect(loom.notes.get(saved.recall_note_id)).toMatchObject({ kind: 'recall', createdBy: 'user' });

    const review = await call('get_recall_review', { source_id: ids.tetlock });
    expect(review.recalls[0].text).toBe('Start from base rates, not vivid anecdotes. Update often.');
    const sim = (w: string) => review.highlights.find((h: any) => h.quote.includes(w)).similarity;
    expect(sim('anecdotes')).toBeGreaterThan(sim('Fluent'));
    expect(review.own_notes.map((n: any) => n.title)).toEqual(['Outside view']);

    const mine = await call('create_note', { title: 'Base rates first', kind: 'claim', body: 'In my words.', source_id: ids.tetlock, authored_by: 'user' });
    expect(mine.authored_by).toBe('user');
    await expect(call('create_note', { kind: 'recall', body: 'x', source_id: ids.tetlock })).rejects.toThrow(/save_recall/);
    expect((await call('get_source', { id: ids.tetlock })).recall_state).toBe('done');
  });

  it('skip_recall marks the source highlights_first', async () => {
    const r = await call('skip_recall', { source_id: ids.kahneman });
    expect(r.recall_state).toBe('skipped');
    expect(loom.sources.get(ids.kahneman).method).toBe('highlights_first');
  });

  it('process_reading asks for recall before highlights and for my drafts before Claude\'s', async () => {
    const p = await client.getPrompt({ name: 'process_reading', arguments: { source: 'Superforecasting' } });
    const text = (p.messages[0].content as { text: string }).text;
    const at = (s: string) => {
      const i = text.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at('save_recall')).toBeLessThan(at('get_recall_review'));
    expect(at('get_recall_review')).toBeLessThan(at('I draft the notes'));
    expect(at('I draft the notes')).toBeLessThan(at('suggest for me'));
    expect(text).toMatch(/Don't show, quote, summarise/);
    expect(text).toContain('authored_by "user"');
    expect(client.getInstructions()).toMatch(/The learner generates first/);
  });
});
