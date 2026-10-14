import { homedir } from 'node:os';
import { join } from 'node:path';
import { Db } from './db.ts';
import type { Ctx } from './services/context.ts';
import { createTags } from './services/tags.ts';
import { createLinks } from './services/links.ts';
import { createSources } from './services/sources.ts';
import { createNotes } from './services/notes.ts';
import { createSearch } from './services/search.ts';
import { drainEmbedQueue, enqueueAll, pendingEmbeddings, transformersEmbedder, VectorIndex, type Embedder } from './services/embeddings.ts';
import { createSettings } from './services/settings.ts';
import { createCards } from './services/cards.ts';
import { createReview } from './services/review.ts';
import { createTopics } from './services/topics.ts';
import type { NoteDetail, SourceDetail } from './types.ts';

export * from './types.ts';
export * as schemas from './schemas.ts';
export { Db } from './db.ts';
export { NotFoundError, ValidationError, localDate } from './util.ts';
export { transformersEmbedder, type Embedder } from './services/embeddings.ts';
export { parseWikilinks } from './services/wikilinks.ts';
export { humanInterval } from './services/review.ts';
export type { Settings } from './services/settings.ts';
export type { TopicMatch } from './services/topics.ts';

export interface LoomOptions {
  /** Path to the SQLite file. Defaults to $LOOM_DB or ~/.loom/loom.db. */
  dbPath?: string;
  /** Embedder for semantic search; `null` disables it. Defaults to local bge-small. */
  embedder?: Embedder | null;
}

export function defaultDataDir(): string {
  return process.env.LOOM_DATA_DIR ?? join(homedir(), '.loom');
}
export function defaultDbPath(): string {
  return process.env.LOOM_DB ?? join(defaultDataDir(), 'loom.db');
}

export function createLoom(opts: LoomOptions = {}) {
  const db = new Db(opts.dbPath ?? defaultDbPath());
  const embedder =
    opts.embedder === undefined ? transformersEmbedder({ cacheDir: join(defaultDataDir(), 'models') }) : opts.embedder;
  const ctx: Ctx = { db, embedder, onNoteSaved: [], onIndexNeeded: [] };

  const tags = createTags(ctx);
  const links = createLinks(ctx);
  const sources = createSources(ctx, tags, links);
  const notes = createNotes(ctx, tags, links);
  const index = new VectorIndex(db);
  const search = createSearch(ctx, index);
  const settings = createSettings(db);
  const cards = createCards(ctx, tags);
  const review = createReview(ctx, cards, settings);
  const topics = createTopics(ctx, search);
  cards.syncMissingClozes();

  const embeddings = {
    pending: () => pendingEmbeddings(db),
    /** Process queued embeddings now (no-op without an embedder). */
    drain: () => (embedder ? drainEmbedQueue(db, embedder) : Promise.resolve(0)),
    /** Queue everything not yet embedded with the current model. */
    reindexAll: () => (embedder ? enqueueAll(db, embedder.model) : 0),
  };

  function noteDetail(id: string): NoteDetail {
    const note = notes.get(id);
    return { ...note, ...links.forItem('note', id), cards: cards.list({ noteId: id, sort: 'created' }).items };
  }

  function sourceDetail(id: string): SourceDetail {
    const source = sources.get(id);
    return {
      ...source,
      notes: notes.list({ sourceId: id, sort: 'location', limit: 1000 }).items,
      ...links.forItem('source', id),
      cardCount: cards.countForItem('source', id),
      tasks: [],
    };
  }

  return {
    db,
    ctx,
    embedder,
    index,
    tags,
    links,
    sources,
    notes,
    search,
    settings,
    cards,
    review,
    topics,
    embeddings,
    noteDetail,
    sourceDetail,
    close: () => db.close(),
  };
}
export type Loom = ReturnType<typeof createLoom>;
