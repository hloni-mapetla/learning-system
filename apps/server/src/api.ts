import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { dirname, join } from 'node:path';
import { MINIMUM_KINDS, REVIEW_CONTEXTS, NotFoundError, parseKindleClippings, resolveDay, schemas, ValidationError, type Loom } from '@loom/core';

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : undefined);
const list = (v: unknown) => (typeof v === 'string' && v !== '' ? v.split(',') : undefined);

/** REST API for the web UI. Every handler is a thin call into @loom/core. */
export function apiRouter(loom: Loom, onWrite: () => void) {
  const r = express.Router();
  r.use(express.json({ limit: '20mb' }));
  r.use((req, res, next) => {
    if (req.method !== 'GET') res.on('finish', onWrite);
    next();
  });

  // ---- status ----
  r.get('/status', (_req, res) => {
    const c = (sql: string) => loom.db.get<{ n: number }>(sql)!.n;
    res.json({
      sources: c('SELECT count(*) AS n FROM sources'),
      notes: c('SELECT count(*) AS n FROM notes'),
      cards: c('SELECT count(*) AS n FROM cards'),
      pendingEmbeddings: loom.embeddings.pending(),
      semantic: !!loom.embedder,
      dbPath: loom.db.path,
    });
  });

  // ---- sources ----
  r.get('/sources', (req, res) => {
    res.json(
      loom.sources.list({
        status: list(req.query.status) as any,
        tag: str(req.query.tag),
        q: str(req.query.q),
        sort: str(req.query.sort) as any,
        limit: num(req.query.limit),
        offset: num(req.query.offset),
      }),
    );
  });
  r.post('/sources', (req, res) => res.status(201).json(loom.sources.create(schemas.SourceCreate.parse(req.body))));
  r.get('/sources/:id', (req, res) => res.json(loom.sourceDetail(req.params.id)));
  r.patch('/sources/:id', (req, res) => res.json(loom.sources.update(req.params.id, schemas.SourcePatch.parse(req.body))));
  r.delete('/sources/:id', (req, res) => {
    loom.sources.remove(req.params.id);
    res.status(204).end();
  });

  // ---- recall-first processing ----
  r.get('/sources/:id/recall', (req, res) => res.json(loom.processing.status(req.params.id)));
  r.post('/sources/:id/recall', (req, res) => {
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    res.status(201).json(loom.processing.saveRecall(req.params.id, text));
  });
  r.post('/sources/:id/recall/skip', (req, res) => res.json(loom.processing.skipRecall(req.params.id)));
  r.get('/sources/:id/recall/compare', async (req, res) => res.json(await loom.processing.compare(req.params.id)));

  // ---- notes ----
  r.get('/notes', (req, res) => {
    res.json(
      loom.notes.list({
        sourceId: str(req.query.sourceId),
        scope: str(req.query.scope) as any,
        since: str(req.query.since),
        kind: list(req.query.kind) as any,
        tag: str(req.query.tag),
        sort: str(req.query.sort) as any,
        limit: num(req.query.limit),
        offset: num(req.query.offset),
      }),
    );
  });
  // Daily notes: one standalone note per day, created on first use.
  r.post('/notes/daily', (req, res) => res.json(loom.notes.daily(z.object({ date: z.string().optional() }).parse(req.body ?? {}).date)));
  r.post('/notes/daily/append', (req, res) => {
    const b = z.object({ text: z.string().min(1), date: z.string().optional() }).parse(req.body);
    res.json(loom.notes.appendDaily(b.text, { date: b.date }));
  });
  r.get('/notes/daily/dates', (_req, res) => res.json(loom.notes.dailyDates()));
  r.post('/notes', (req, res) => res.status(201).json(loom.notes.create(schemas.NoteCreate.parse(req.body))));
  r.get('/notes/:id', (req, res) => res.json(loom.noteDetail(req.params.id)));
  r.patch('/notes/:id', (req, res) => res.json(loom.notes.update(req.params.id, schemas.NotePatch.parse(req.body))));
  r.delete('/notes/:id', (req, res) => {
    loom.notes.remove(req.params.id);
    res.status(204).end();
  });
  r.get('/resolve', (req, res) => res.json(loom.links.resolveTitle(str(req.query.title) ?? '')));
  r.get('/titles',(req, res) => res.json(loom.notes.suggestTitles(str(req.query.prefix) ?? '', num(req.query.limit))));

  // ---- links & tags ----
  r.post('/links', (req, res) => res.status(201).json(loom.links.create(schemas.LinkCreate.parse(req.body), 'user')));
  r.delete('/links/:id', (req, res) => {
    loom.links.remove(req.params.id);
    res.status(204).end();
  });
  r.get('/tags', (_req, res) => res.json(loom.tags.list()));

  // ---- cards ----
  r.get('/cards', (req, res) => {
    res.json(
      loom.cards.list({
        noteId: str(req.query.noteId),
        sourceId: str(req.query.sourceId),
        tag: str(req.query.tag),
        type: str(req.query.type) as any,
        state: str(req.query.state) as any,
        suspended: req.query.suspended === undefined ? undefined : req.query.suspended === 'true',
        sort: str(req.query.sort) as any,
        limit: num(req.query.limit),
        offset: num(req.query.offset),
      }),
    );
  });
  r.post('/cards', (req, res) => res.status(201).json(loom.cards.create(schemas.CardCreate.parse(req.body), 'user')));
  r.get('/cards/:id', (req, res) =>
    res.json({ ...loom.cards.get(req.params.id), history: loom.review.history(req.params.id) }),
  );
  r.patch('/cards/:id', (req, res) => res.json(loom.cards.update(req.params.id, schemas.CardPatch.parse(req.body))));
  r.delete('/cards/:id', (req, res) => {
    loom.cards.remove(req.params.id);
    res.status(204).end();
  });
  r.post('/cards/:id/forget', (req, res) => res.json(loom.review.forget(req.params.id)));

  // ---- review ----
  r.get('/review/due', (req, res) =>
    res.json(loom.review.due({ limit: num(req.query.limit) ?? 200, tag: str(req.query.tag) })),
  );
  r.get('/review/counts', (req, res) => res.json(loom.review.counts({ tag: str(req.query.tag) })));
  r.get('/review/preview/:id', (req, res) => res.json(loom.review.preview(req.params.id)));
  r.post('/review/undo', (req, res) => res.json(loom.review.undo(str(req.body?.cardId))));
  r.post('/review/:id', (req, res) => {
    const body = z
      .object({
        rating: schemas.RatingInput,
        durationMs: z.number().int().nonnegative().nullish(),
        notes: z.string().nullish(),
        context: z.enum(REVIEW_CONTEXTS).optional(),
      })
      .parse(req.body);
    res.json(loom.review.record(req.params.id, body.rating, { grader: 'self', durationMs: body.durationMs, notes: body.notes, context: body.context ?? 'ui' }));
  });
  // ---- interleaved practice across topics ----
  r.get('/practice', async (req, res) =>
    res.json(
      await loom.practice.practiceSet({
        topics: list(req.query.topics) ?? [],
        size: num(req.query.size),
        includeNotDue: req.query.notDue !== 'false',
      }),
    ),
  );
  r.get('/confusables', async (req, res) => res.json(await loom.practice.confusables({ topics: list(req.query.topics) ?? [], limit: num(req.query.limit) })));
  r.get('/review/forecast', (req, res) => res.json(loom.review.forecast(num(req.query.days) ?? 30)));

  // ---- tasks ----
  r.get('/tasks', (req, res) =>
    res.json(loom.tasks.list({ view: (str(req.query.view) as any) ?? 'all_open', sourceId: str(req.query.sourceId) })),
  );
  r.get('/reading-queue', (_req, res) => res.json(loom.tasks.readingQueue()));
  r.post('/tasks', (req, res) => res.status(201).json(loom.tasks.create(schemas.TaskCreate.parse(req.body))));
  r.patch('/tasks/:id', (req, res) => res.json(loom.tasks.update(req.params.id, schemas.TaskPatch.parse(req.body))));
  r.post('/tasks/:id/complete', (req, res) => res.json(loom.tasks.complete(req.params.id)));
  r.delete('/tasks/:id', (req, res) => {
    loom.tasks.remove(req.params.id);
    res.status(204).end();
  });
  r.get('/done-today', (_req, res) => res.json(loom.tasks.doneToday()));
  r.get('/tasks/:id', (req, res) => res.json(loom.tasks.get(req.params.id)));

  // ---- sessions (starter / focus) and the parking lot ----
  r.get('/sessions/state', (_req, res) => res.json(loom.sessions.state()));
  r.get('/sessions', (req, res) => res.json(loom.sessions.list({ from: str(req.query.from), to: str(req.query.to), limit: num(req.query.limit) })));
  r.post('/sessions', (req, res) => {
    const b = z
      .object({
        kind: z.enum(['starter', 'focus']),
        taskId: z.string().nullish(),
        subtaskId: z.string().nullish(),
        minutes: z.number().positive().optional(),
        continuedFrom: z.string().nullish(),
      })
      .parse(req.body);
    res.status(201).json(loom.sessions.start(b));
  });
  r.post('/sessions/:id/end', (req, res) => {
    const { outcome } = z.object({ outcome: z.literal('abandoned').optional() }).parse(req.body ?? {});
    res.json(loom.sessions.end(req.params.id, { outcome }));
  });
  r.post('/sessions/:id/keep-going', (req, res) => res.status(201).json(loom.sessions.keepGoing(req.params.id)));
  r.post('/park', (req, res) => res.json(loom.sessions.park(z.object({ text: z.string().min(1) }).parse(req.body).text)));

  // ---- days: the evening plan, the morning and the routine (:date = today | tomorrow | yesterday | YYYY-MM-DD) ----
  const hhmm = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Expected a time like 07:30');
  r.get('/days/:date', (req, res) => res.json(loom.days.get(req.params.date)));
  r.patch('/days/:date', (req, res) => {
    const b = z.object({ wakeAt: hhmm.nullable(), workStartAt: hhmm.nullable(), targetStart: hhmm.nullable() }).partial().parse(req.body);
    const d = req.params.date;
    if (b.wakeAt !== undefined) loom.days.logWake(d, b.wakeAt);
    if (b.workStartAt !== undefined) loom.days.setWorkStart(d, b.workStartAt);
    if (b.targetStart !== undefined) loom.days.setTargetStart(d, b.targetStart);
    res.json(loom.days.get(d));
  });
  r.post('/days/:date/wake', (req, res) => {
    const { at } = z.object({ at: hhmm.optional() }).parse(req.body ?? {});
    res.json(loom.days.logWake(req.params.date, at ?? new Date()));
  });
  r.put('/days/:date/plan', (req, res) => {
    const b = z
      .object({ taskId: z.string(), subtaskId: z.string().nullish(), stepTitle: z.string().nullish(), targetStart: hhmm.nullish() })
      .parse(req.body);
    res.json(loom.days.plan(req.params.date, b));
  });
  r.delete('/days/:date/plan', (req, res) => res.json(loom.days.clearPlan(req.params.date)));
  r.post('/days/:date/shutdown', (req, res) => {
    const b = z.object({ note: z.string().optional(), undo: z.boolean().optional() }).parse(req.body ?? {});
    res.json(loom.days.shutdown(req.params.date, b));
  });
  r.post('/days/:date/routine/:itemId', (req, res) => {
    const { checked } = z.object({ checked: z.boolean() }).parse(req.body);
    res.json(loom.days.check(req.params.date, req.params.itemId, checked));
  });
  r.put('/days/:date/rating', (req, res) => {
    const b = z.object({ rating: z.number().int().min(1).max(5), note: z.string().optional() }).parse(req.body);
    res.json(loom.momentum.rate(resolveDay(req.params.date), b.rating, b.note));
  });
  r.get('/done', (req, res) => res.json(loom.tasks.doneOn(resolveDay(str(req.query.date)))));

  // ---- momentum: the daily minimum, the chain and stats ----
  r.get('/momentum/chain', (req, res) => res.json(loom.momentum.chain({ days: num(req.query.days) })));
  r.get('/momentum/stats', (req, res) => res.json(loom.momentum.stats({ days: num(req.query.days) })));
  r.put('/momentum/minimum', (req, res) => {
    const b = z.object({ kind: z.enum(MINIMUM_KINDS), value: z.number().int().min(1).max(600) }).parse(req.body);
    res.json(loom.momentum.setMinimum(b));
  });
  r.get('/routine', (_req, res) => res.json(loom.days.routine()));
  r.post('/routine', (req, res) => {
    const b = z.object({ title: z.string().trim().min(1), optional: z.boolean().optional(), position: z.number().int().min(0).optional() }).parse(req.body);
    res.status(201).json(loom.days.addItem(b.title, b));
  });
  r.patch('/routine/:id', (req, res) =>
    res.json(loom.days.updateItem(req.params.id, z.object({ title: z.string().trim().min(1), optional: z.boolean() }).partial().parse(req.body))),
  );
  r.post('/routine/:id/move', (req, res) => res.json(loom.days.moveItem(req.params.id, z.object({ delta: z.number().int() }).parse(req.body).delta)));
  r.delete('/routine/:id', (req, res) => {
    loom.days.removeItem(req.params.id);
    res.status(204).end();
  });

  // ---- subtasks (steps) ----
  r.post('/tasks/:id/subtasks', (req, res) => {
    const b = schemas.SubtaskCreate.partial({ title: true }).extend({ titles: z.array(z.string()).optional() }).parse(req.body);
    res.status(201).json(loom.subtasks.add(req.params.id, b.titles ?? (b.title ? [b.title] : []), { position: b.position }));
  });
  r.put('/tasks/:id/subtasks/order', (req, res) =>
    res.json(loom.subtasks.reorder(req.params.id, z.object({ ids: z.array(z.string()) }).parse(req.body).ids)),
  );
  r.patch('/subtasks/:id', (req, res) => res.json(loom.subtasks.update(req.params.id, schemas.SubtaskPatch.parse(req.body))));
  r.post('/subtasks/:id/complete', (req, res) => {
    const { undo } = z.object({ undo: z.boolean().optional() }).parse(req.body ?? {});
    res.json(undo ? loom.subtasks.uncomplete(req.params.id) : loom.subtasks.complete(req.params.id));
  });
  r.post('/subtasks/:id/move', (req, res) =>
    res.json(loom.subtasks.move(req.params.id, z.object({ delta: z.number().int() }).parse(req.body).delta)),
  );
  r.delete('/subtasks/:id', (req, res) => res.json(loom.subtasks.remove(req.params.id)));

  // ---- graph & connections ----
  r.get('/graph', (req, res) =>
    res.json(
      loom.graph.build({
        focus: str(req.query.focus),
        depth: num(req.query.depth),
        tag: str(req.query.tag),
        noteKinds: list(req.query.kinds),
        includeSourceEdges: req.query.sourceEdges !== 'false',
        hideIsolated: req.query.hideIsolated === 'true',
      }),
    ),
  );
  r.get('/similar/:type/:id', async (req, res) => {
    const type = z.enum(['note', 'source']).parse(req.params.type);
    res.json(
      await loom.related.similar(type, req.params.id, {
        limit: num(req.query.limit) ?? 8,
        crossSourceOnly: req.query.crossSource === 'true',
        excludeLinked: true,
      }),
    );
  });

  // ---- stats, import, export ----
  r.get('/stats', (_req, res) => res.json(loom.stats.compute()));
  r.post('/import/kindle', (req, res) => {
    const body = z.object({ text: z.string().min(1), books: z.array(z.string()).optional() }).parse(req.body);
    res.json(loom.importer.kindle(body.text, { onlyBooks: body.books }));
  });
  r.post('/import/kindle/preview', (req, res) => {
    const { text } = z.object({ text: z.string() }).parse(req.body);
    const books = new Map<string, { title: string; author: string; highlights: number; notes: number }>();
    for (const c of parseKindleClippings(text)) {
      const b = books.get(c.bookTitle) ?? { title: c.bookTitle, author: c.author, highlights: 0, notes: 0 };
      if (c.kind === 'highlight') b.highlights++;
      else b.notes++;
      books.set(c.bookTitle, b);
    }
    res.json([...books.values()]);
  });
  r.post('/import/markdown', (req, res) => {
    const body = z.object({ files: z.array(z.object({ name: z.string(), content: z.string() })), sourceId: z.string().nullish() }).parse(req.body);
    const total = { created: 0, skipped: 0, noteIds: [] as string[], sources: [] as unknown[] };
    for (const f of body.files) {
      const r1 = loom.importer.markdown(f.content, { filename: f.name, sourceId: body.sourceId ?? undefined });
      total.created += r1.created;
      total.skipped += r1.skipped;
      total.noteIds.push(...r1.noteIds);
      total.sources.push(...r1.sources);
    }
    res.json(total);
  });
  r.post('/import/paste', (req, res) => {
    const b = z.object({ text: z.string().min(1), sourceId: z.string().nullish(), sourceTitle: z.string().nullish(), authors: z.string().nullish() }).parse(req.body);
    res.json(loom.importer.pasted(b.text, { sourceId: b.sourceId ?? undefined, sourceTitle: b.sourceTitle ?? undefined, authors: b.authors ?? undefined }));
  });
  r.get('/export/json', (_req, res) => {
    res.set('Content-Disposition', `attachment; filename="loom-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(loom.exporter.json());
  });
  r.post('/export/markdown', (_req, res) => {
    const dir = join(dirname(loom.db.path), 'exports', `vault-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
    res.json({ dir, ...loom.exporter.markdownVault(dir) });
  });
  r.post('/backup', (_req, res) => res.json({ path: loom.exporter.backup(join(dirname(loom.db.path), 'backups')) }));

  // ---- settings ----
  r.get('/settings', (_req, res) => res.json(loom.settings.get()));
  r.patch('/settings', (req, res) => {
    const body = z
      .object({
        desiredRetention: z.number().min(0.7).max(0.99),
        maximumInterval: z.number().int().min(1),
        newCardsPerDay: z.number().int().min(0).max(1000),
        learnAheadMinutes: z.number().int().min(0).max(240),
        starterMinutes: z.number().min(1).max(60),
        focusMinutes: z.number().min(5).max(240),
        breakMinutes: z.number().min(0).max(60),
        interleave: z.boolean(),
      })
      .partial()
      .parse(req.body);
    res.json(loom.settings.set(body));
  });

  // ---- search ----
  r.get('/search', async (req, res) => {
    const q = str(req.query.q) ?? '';
    const mode = str(req.query.mode) ?? 'hybrid';
    const opts = { limit: num(req.query.limit), types: list(req.query.types) as any, noteKinds: list(req.query.kinds) };
    const hits =
      mode === 'text' ? loom.search.fullText(q, opts) : mode === 'semantic' ? await loom.search.semantic(q, opts) : await loom.search.hybrid(q, opts);
    res.json(hits);
  });

  r.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  r.use(errorHandler);
  return r;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues });
  if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}
