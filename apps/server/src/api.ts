import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { NotFoundError, schemas, ValidationError, type Loom } from '@loom/core';

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

  // ---- notes ----
  r.get('/notes', (req, res) => {
    res.json(
      loom.notes.list({
        sourceId: str(req.query.sourceId),
        kind: list(req.query.kind) as any,
        tag: str(req.query.tag),
        sort: str(req.query.sort) as any,
        limit: num(req.query.limit),
        offset: num(req.query.offset),
      }),
    );
  });
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
